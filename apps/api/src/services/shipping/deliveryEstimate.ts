import { volumetricWeightGrams, type SellerDeliveryEstimate, type SellerDeliveryEstimateCase } from '@clowe/shared';
import { prisma } from '../../db';
import { getSettings } from '../settingsService';
import { shippingProvider } from './index';
import { cachedQuote, clearCourierCache, slabOf } from './courierCache';
import { chargeableGrams, type ParcelRoute } from './freight';
import { pickupAddress } from './shipments';

// ---------------------------------------------------------------------------
// The seller's delivery estimate, for the product form and the shipping
// charges calculator: what a parcel of this size costs them to send from
// their pickup pincode to three kinds of destination (and a PIN they type),
// what it adds if it comes back undelivered (RTO) and what a customer
// return's pickup costs — all GST included, at Delhivery's live rates. Delhivery
// bills per 0.5 kg slab on the greater of actual and volumetric weight, so
// answers are cached for a day per route and slab (courierCache): a seller
// typing a weight doesn't call Delhivery on every key.
// ---------------------------------------------------------------------------

/** Three destinations: their own city, a metro far from it, and a remote one. */
const METRO = '400001';
const METRO_ALT = '110001';
const FAR = '190001';

/** For tests: forget every cached answer. */
export function clearDeliveryEstimateCache(): void {
  clearCourierCache();
}

export async function deliveryEstimate(
  sellerId: string,
  parcel: { weightGrams: number; lengthMm: number | null; widthMm: number | null; heightMm: number | null },
  buyerPricePaise: number,
  opts: { destinationPincode?: string | null } = {},
): Promise<SellerDeliveryEstimate> {
  const [seller, settings] = await Promise.all([prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } }), getSettings()]);
  const origin = pickupAddress(seller).pincode;
  const chargeable = chargeableGrams(parcel);
  const slabGrams = slabOf(chargeable);
  const base = {
    actualGrams: parcel.weightGrams,
    volumetricGrams: volumetricWeightGrams(parcel.lengthMm, parcel.widthMm, parcel.heightMm),
    chargeableGrams: chargeable,
    slabGrams,
    provider: shippingProvider.name,
  };
  if (!origin) {
    return { ...base, originPincode: null, cases: [], codFeePaise: null, error: 'Add your pickup pincode in Store Settings to see delivery estimates' };
  }

  const metro = origin.slice(0, 3) === METRO.slice(0, 3) ? METRO_ALT : METRO;
  const destinations = [
    { key: 'local', label: 'Same city', pincode: origin },
    { key: 'metro', label: 'Metro', pincode: metro },
    { key: 'far', label: 'Far (J&K)', pincode: FAR },
    ...(opts.destinationPincode ? [{ key: 'custom', label: 'Your PIN', pincode: opts.destinationPincode }] : []),
  ];
  const route = (destination: string): ParcelRoute => ({ originPincode: origin, destinationPincode: destination, mode: 'SURFACE', weightGrams: slabGrams });
  // A leg Delhivery won't price (a remote return, say) is shown as such; the forward one is the estimate.
  const optional = (p: Promise<number>) => p.then((v): number | null => v).catch((): number | null => null);

  try {
    const cases = await Promise.all(
      destinations.map(async (d): Promise<SellerDeliveryEstimateCase> => {
        const forward = await cachedQuote({ ...route(d.pincode), kind: 'DELIVERED', payment: 'PREPAID' });
        const [rto, back] = await Promise.all([
          // Delhivery's RTO quote is the forward and return legs together.
          optional(cachedQuote({ ...route(d.pincode), kind: 'RTO', payment: 'PREPAID' }).then((q) => Math.max(0, q.totalPaise - forward.totalPaise))),
          // A customer return travels from the buyer back to the seller.
          optional(
            cachedQuote({ originPincode: d.pincode, destinationPincode: origin, mode: 'SURFACE', weightGrams: slabGrams, kind: 'DTO', payment: 'PREPAID' }).then(
              (q) => q.totalPaise,
            ),
          ),
        ]);
        return { key: d.key, label: d.label, destinationPincode: d.pincode, zone: forward.zone, freightPaise: forward.totalPaise, rtoPaise: rto, returnPaise: back };
      }),
    );
    // COD isn't offered (Clowe-wide, or by this seller): no COD fee to show.
    const codOn = settings.codEnabled && seller.codEnabled;
    const cod =
      codOn && buyerPricePaise > 0
        ? await optional(
            Promise.all([
              cachedQuote({ ...route(origin), kind: 'DELIVERED', payment: 'PREPAID' }),
              cachedQuote({ ...route(origin), kind: 'DELIVERED', payment: 'COD', codAmountPaise: buyerPricePaise }),
            ]).then(([prepaid, withCod]) => Math.max(0, withCod.totalPaise - prepaid.totalPaise)),
          )
        : null;
    return { ...base, originPincode: origin, cases, codFeePaise: cod, error: null };
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
