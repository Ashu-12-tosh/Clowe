import { type DeliveryMethod, type DeliveryOption } from '@clowe/shared';

// ---------------------------------------------------------------------------
// Delivery as the buyer sees it: always free. Buyers never pay a delivery
// fee — the seller pays Delhivery's freight — and only standard delivery
// (Delhivery Surface) is offered. Express and same-day stay in the enum for
// orders placed before, and are refused for new ones.
// ---------------------------------------------------------------------------

/** The speeds a buyer can choose now. */
export const OFFERED_DELIVERY_METHODS: readonly DeliveryMethod[] = ['STANDARD'];

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
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

function etaLabel(from: Date, to: Date): string {
  if (shortDate(from) === shortDate(to)) return `Delivered by ${shortDate(from)}`;
  return `Delivered by ${shortDate(from)} – ${shortDate(to)}`;
}

/** What the buyer pays for delivery: nothing, at any speed or order value. */
export function deliveryPriceFor(): number {
  return 0;
}

export function etaWindowFor(method: DeliveryMethod, now = new Date()): { from: Date; to: Date } {
  const [minDays, maxDays] = WINDOW_DAYS[method];
  return { from: addDays(now, minDays), to: addDays(now, maxDays) };
}

/** The checkout's delivery step: the offered speeds, free and dated. */
export function deliveryOptionsFor(now = new Date()): DeliveryOption[] {
  return OFFERED_DELIVERY_METHODS.map((method) => {
    const { from, to } = etaWindowFor(method, now);
    return {
      method,
      label: LABELS[method],
      etaLabel: etaLabel(from, to),
      pricePaise: 0,
      strikePaise: null,
      available: true,
      unavailableReason: null,
      etaFrom: from.toISOString(),
      etaTo: to.toISOString(),
    };
  });
}

/** Whether checkout may take this speed. */
export function isDeliveryMethodAvailable(method: DeliveryMethod): boolean {
  return OFFERED_DELIVERY_METHODS.includes(method);
}
