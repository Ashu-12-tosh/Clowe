import { shippingProvider } from './index';
import type { PincodeServiceability } from './ShippingProvider';

// ---------------------------------------------------------------------------
// Does Delhivery deliver here, and will it collect cash here?
//
// Asked by the product page's pincode check, the payment step and checkout.
// Answers are cached per pincode for a few hours (they change rarely, and a
// product page is viewed far more often than Delhivery should be asked). If
// Delhivery can't be reached the answer is "unknown" and nothing is refused
// on its account: the booking checks again before anything ships.
// ---------------------------------------------------------------------------

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: PincodeServiceability }>();

/** For tests: forget every cached answer. */
export function clearServiceabilityCache(): void {
  cache.clear();
}

/** Delhivery's answer for a pincode, or null when it could not be asked. */
export async function pincodeServiceability(pincode: string): Promise<PincodeServiceability | null> {
  const pin = pincode.trim();
  // The mock is free and instant: never cached, so tests and dev see changes at once.
  const useCache = shippingProvider.name !== 'mock';
  const hit = useCache ? cache.get(pin) : undefined;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const value = await shippingProvider.checkPincode(pin);
    if (useCache) cache.set(pin, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.error('[clowe-api] pincode check unavailable for', pin, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Why an order can't go to this pincode at all; null when it can (or we can't tell). */
export function deliveryRefusal(pincode: string, check: PincodeServiceability | null): string | null {
  if (!check || check.serviceable) return null;
  return `Delhivery doesn't deliver to ${pincode} yet — please choose another address`;
}

/** Why cash on delivery isn't available for this amount here; null when it is (or we can't tell). */
export function codRefusal(pincode: string, totalPaise: number, check: PincodeServiceability | null): string | null {
  if (!check) return null;
  if (!check.cod) return `Cash on Delivery isn't available at ${pincode} — please pay online`;
  if (check.codLimitPaise !== null && totalPaise > check.codLimitPaise) {
    return `Cash on Delivery at ${pincode} is available up to ₹${(check.codLimitPaise / 100).toLocaleString('en-IN')} — please pay online`;
  }
  return null;
}
