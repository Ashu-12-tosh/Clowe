import { shippingProvider } from './index';
import type { FreightQuote, FreightQuoteRequest, TransitEstimate } from './ShippingProvider';

// ---------------------------------------------------------------------------
// Delhivery's read-only answers, remembered for a day (owner, 26 Oct): rates
// per origin pincode + destination pincode + 0.5 kg slab (and kind), transit
// times per origin + destination. A product page, a cart or a seller typing
// a weight shouldn't ask Delhivery the same question again within the day.
//
// The mock is free and follows the admin's test rate at once: never cached.
// A failure is not remembered: the next ask tries again. What a seller is
// finally charged (freight.ts) is always asked fresh, never from here.
// ---------------------------------------------------------------------------

export const COURIER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SLAB_GRAMS = 500;

/** The 0.5 kg slab a weight is priced in: what Delhivery bills. */
export function slabOf(grams: number): number {
  return Math.max(1, Math.ceil(grams / SLAB_GRAMS)) * SLAB_GRAMS;
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function remembered<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (shippingProvider.name === 'mock') return load();
  const full = `${shippingProvider.name}:${shippingProvider.environment}:${key}`;
  const hit = cache.get(full);
  if (hit && Date.now() - hit.at < COURIER_CACHE_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(full, { at: Date.now(), value });
  value.catch(() => cache.delete(full));
  return value;
}

/** For tests: forget every cached answer. */
export function clearCourierCache(): void {
  cache.clear();
}

/** A rate quote at the request's slab, from the day's cache. */
export function cachedQuote(request: FreightQuoteRequest): Promise<FreightQuote> {
  const slab = slabOf(request.weightGrams);
  const cod = request.payment === 'COD' ? `:${request.codAmountPaise ?? 0}` : '';
  return remembered(
    `quote:${request.originPincode}:${request.destinationPincode}:${slab}:${request.kind}:${request.mode}:${request.payment}${cod}`,
    () => shippingProvider.quote({ ...request, weightGrams: slab }),
  );
}

/**
 * Delhivery's transit time from a pickup pincode to a delivery one, from the
 * day's cache. Asked for tomorrow's pickup: the TAT, not the date, is what is
 * used, and it doesn't change from one day to the next.
 */
export function cachedTransit(originPincode: string, destinationPincode: string): Promise<TransitEstimate> {
  return remembered(`tat:${originPincode}:${destinationPincode}`, () =>
    shippingProvider.expectedTat(originPincode, destinationPincode, new Date(Date.now() + 24 * 60 * 60 * 1000)),
  );
}

/** `promise`, or null if it takes longer than `ms` or fails: the buyer never waits on Delhivery. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
