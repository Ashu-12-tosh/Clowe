import type { SellerDeliveryEstimate } from '@clowe/shared';
import { prisma } from '../../db';
import { shippingProvider } from './index';
import { chargeableGrams, codFeePaise, type ParcelRoute } from './freight';
import { pickupAddress } from './shipments';

// ---------------------------------------------------------------------------
// The pricing calculator's delivery estimate: what a parcel of this product
// costs the seller to send, from their pickup pincode to three kinds of
// destination, and what COD adds. Delhivery bills per 0.5 kg slab on the
// greater of actual and volumetric weight, so answers are cached per route
// and slab: a seller typing a weight doesn't call Delhivery on every key.
// ---------------------------------------------------------------------------

const SLAB_GRAMS = 500;
const TTL_MS = 6 * 60 * 60 * 1000;
/** Three destinations: their own city, a metro far from it, and a remote one. */
const METRO = '400001';
const METRO_ALT = '110001';
const FAR = '190001';

const cache = new Map<string, { at: number; value: Promise<{ zone: string; totalPaise: number }> }>();

function cached<T extends { zone: string; totalPaise: number }>(key: string, load: () => Promise<T>): Promise<T> {
  // The mock is free and follows the admin's test rate at once: never cached.
  if (shippingProvider.name === 'mock') return load();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  // A failure is not remembered: the next look tries again.
  value.catch(() => cache.delete(key));
  return value;
}

/** For tests: forget every cached answer. */
export function clearDeliveryEstimateCache(): void {
  cache.clear();
}

export async function deliveryEstimate(
  sellerId: string,
  parcel: { weightGrams: number; lengthMm: number | null; widthMm: number | null; heightMm: number | null },
  buyerPricePaise: number,
): Promise<SellerDeliveryEstimate> {
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } });
  const origin = pickupAddress(seller).pincode;
  const chargeable = chargeableGrams(parcel);
  const slabGrams = Math.max(1, Math.ceil(chargeable / SLAB_GRAMS)) * SLAB_GRAMS;
  const base = { chargeableGrams: chargeable, slabGrams, provider: shippingProvider.name };
  if (!origin) {
    return { ...base, originPincode: null, cases: [], codFeePaise: null, error: 'Add your pickup pincode in Store Settings to see delivery estimates' };
  }

  const metro = origin.slice(0, 3) === METRO.slice(0, 3) ? METRO_ALT : METRO;
  const destinations = [
    { key: 'local', label: 'Same city', pincode: origin },
    { key: 'metro', label: 'Metro', pincode: metro },
    { key: 'far', label: 'Far (J&K)', pincode: FAR },
  ];
  const route = (destination: string): ParcelRoute => ({
    originPincode: origin,
    destinationPincode: destination,
    mode: 'SURFACE',
    weightGrams: slabGrams,
  });

  try {
    const cases = await Promise.all(
      destinations.map(async (d) => {
        const q = await cached(`${shippingProvider.name}:${shippingProvider.environment}:${origin}:${d.pincode}:${slabGrams}`, () =>
          shippingProvider.quote({ ...route(d.pincode), kind: 'DELIVERED', payment: 'PREPAID' }),
        );
        return { key: d.key, label: d.label, destinationPincode: d.pincode, zone: q.zone, freightPaise: q.totalPaise };
      }),
    );
    const cod =
      buyerPricePaise > 0
        ? await cached(`${shippingProvider.name}:${shippingProvider.environment}:cod:${origin}:${slabGrams}:${buyerPricePaise}`, async () => ({
            zone: '',
            totalPaise: await codFeePaise(route(origin), buyerPricePaise),
          }))
        : null;
    return { ...base, originPincode: origin, cases, codFeePaise: cod?.totalPaise ?? null, error: null };
  } catch (err) {
    return {
      ...base,
      originPincode: origin,
      cases: [],
      codFeePaise: null,
      error: `No estimate from Delhivery right now${err instanceof Error ? ` (${err.message})` : ''}`,
    };
  }
}
