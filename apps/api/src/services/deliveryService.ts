import {
  DELIVERY_METHODS,
  type DeliveryMethod,
  type DeliveryOption,
} from '@clowe/shared';

// Standard shipping rule: free at/above ₹999, else ₹49.
export const FREE_SHIPPING_THRESHOLD_PAISE = 99900;
export const SHIPPING_FEE_PAISE = 4900;

/**
 * Standard-speed shipping for a subtotal. Premium members get it free with no
 * minimum — that is the membership's headline benefit.
 */
export function shippingFor(subtotalPaise: number, isPremium = false): number {
  if (subtotalPaise === 0) return 0;
  if (isPremium) return 0;
  return subtotalPaise >= FREE_SHIPPING_THRESHOLD_PAISE ? 0 : SHIPPING_FEE_PAISE;
}

/** Same-day orders must be placed before this hour (IST) to go out today. */
export const SAME_DAY_CUTOFF_HOUR = 14;

const EXPRESS_FEE_PAISE = 7900;
const EXPRESS_LIST_PAISE = 12900;
const SAME_DAY_FEE_PAISE = 14900;
const SAME_DAY_LIST_PAISE = 19900;

/** Business days each speed takes, as an inclusive [from, to] day offset. */
const WINDOW_DAYS: Record<DeliveryMethod, [number, number]> = {
  STANDARD: [4, 6],
  EXPRESS: [2, 2],
  SAME_DAY: [0, 0],
};

const LABELS: Record<DeliveryMethod, string> = {
  STANDARD: 'Standard Delivery',
  EXPRESS: 'Express Delivery',
  SAME_DAY: 'Same Day Delivery',
};

function addDays(from: Date, days: number): Date {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

/** "27 May" — the short form used across the delivery UI. */
function shortDate(date: Date): string {
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function etaLabel(method: DeliveryMethod, from: Date, to: Date): string {
  if (method === 'SAME_DAY') return 'Delivered Today by 9 PM';
  if (shortDate(from) === shortDate(to)) return `Delivered by ${shortDate(from)}`;
  return `Delivered by ${shortDate(from)} – ${shortDate(to)}`;
}

/** Hour of day in IST, regardless of where the server runs. */
function istHour(now: Date): number {
  return Number(
    now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }),
  );
}

/**
 * What a delivery speed costs for this cart. Standard rides the site-wide
 * free-shipping rule; the faster speeds are flat fees.
 */
export function deliveryPriceFor(
  method: DeliveryMethod,
  subtotalPaise: number,
  isPremium = false,
): number {
  switch (method) {
    case 'EXPRESS':
      return EXPRESS_FEE_PAISE;
    case 'SAME_DAY':
      return SAME_DAY_FEE_PAISE;
    case 'STANDARD':
    default:
      return shippingFor(subtotalPaise, isPremium);
  }
}

function listPriceFor(method: DeliveryMethod, pricePaise: number): number | null {
  if (method === 'EXPRESS') return EXPRESS_LIST_PAISE;
  if (method === 'SAME_DAY') return SAME_DAY_LIST_PAISE;
  // Standard shows its usual fee struck through only when it came out free.
  return pricePaise === 0 ? SHIPPING_FEE_PAISE : null;
}

export function etaWindowFor(method: DeliveryMethod, now = new Date()): { from: Date; to: Date } {
  const [minDays, maxDays] = WINDOW_DAYS[method];
  return { from: addDays(now, minDays), to: addDays(now, maxDays) };
}

/** Every speed, priced and dated for this cart — the checkout's step 2. */
export function deliveryOptionsFor(
  subtotalPaise: number,
  now = new Date(),
  isPremium = false,
): DeliveryOption[] {
  const pastCutoff = istHour(now) >= SAME_DAY_CUTOFF_HOUR;

  return DELIVERY_METHODS.map((method) => {
    const pricePaise = deliveryPriceFor(method, subtotalPaise, isPremium);
    const { from, to } = etaWindowFor(method, now);
    const available = method !== 'SAME_DAY' || !pastCutoff;
    return {
      method,
      label: LABELS[method],
      etaLabel: available
        ? etaLabel(method, from, to)
        : `Order before ${SAME_DAY_CUTOFF_HOUR}:00 for same-day`,
      pricePaise,
      strikePaise: listPriceFor(method, pricePaise),
      available,
      unavailableReason: available
        ? null
        : `Same-day cut-off is ${SAME_DAY_CUTOFF_HOUR}:00 — try Express instead`,
      etaFrom: from.toISOString(),
      etaTo: to.toISOString(),
    };
  });
}

/** Throws-free availability check used by checkout before charging. */
export function isDeliveryMethodAvailable(method: DeliveryMethod, now = new Date()): boolean {
  return deliveryOptionsFor(0, now).find((o) => o.method === method)?.available ?? false;
}
