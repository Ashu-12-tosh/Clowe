import { prisma } from '../db';

// ---------------------------------------------------------------------------
// What a buyer's own open unpaid orders are holding for the cart in hand.
//
// An online order reserves its units, credits and coupon use when it is
// placed, before it is paid. If the buyer comes back to the same items — a
// refresh, a second tab, Pay pressed again after a lost answer — checkout will
// hand that order back or replace it (services/checkoutDedup), so what it holds
// is theirs to use: their last unit is not "out of stock", their credits are
// not "spent" and their once-per-account coupon is not "already used".
// Only orders sharing an item with the cart count: an unrelated open order
// keeps its reservations.
// ---------------------------------------------------------------------------

/** Unpaid orders older than this are the sweeper's, not checkout's (as checkoutDedup). */
export const OPEN_ORDER_LOOKBACK_MS = 2 * 60 * 60_000;
/** An order with no gateway order yet is being set up by another request for this long. */
export const OPEN_ORDER_SETUP_GRACE_MS = 60_000;

export interface OpenHolds {
  orderIds: string[];
  /** Units held per variant. */
  units: Map<string, number>;
  credits: number;
  /** Coupon redemptions held, per code. */
  coupons: Map<string, number>;
}

export async function openHoldsFor(userId: string, variantIds: string[], now: Date = new Date()): Promise<OpenHolds> {
  const holds: OpenHolds = { orderIds: [], units: new Map(), credits: 0, coupons: new Map() };
  if (variantIds.length === 0) return holds;
  const open = await prisma.order.findMany({
    where: {
      userId,
      status: 'PLACED',
      paymentMethod: { not: 'COD' },
      payment: { status: 'CREATED' },
      createdAt: { gt: new Date(now.getTime() - OPEN_ORDER_LOOKBACK_MS) },
      // One whose gateway order exists, or one another tab is setting up right
      // now; one abandoned half-way (no gateway order after a minute) holds
      // nothing checkout would hand back, as in checkoutDedup.
      OR: [
        { payment: { providerOrderId: { not: null } } },
        { createdAt: { gt: new Date(now.getTime() - OPEN_ORDER_SETUP_GRACE_MS) } },
      ],
      items: { some: { variantId: { in: variantIds } } },
    },
    select: { id: true, creditsUsed: true, couponCode: true, couponDiscountPaise: true, items: { select: { variantId: true, quantity: true, status: true } } },
  });
  for (const o of open) {
    holds.orderIds.push(o.id);
    holds.credits += o.creditsUsed;
    if (o.couponCode && o.couponDiscountPaise > 0) holds.coupons.set(o.couponCode, (holds.coupons.get(o.couponCode) ?? 0) + 1);
    for (const i of o.items) {
      if (i.status !== 'PLACED') continue;
      holds.units.set(i.variantId, (holds.units.get(i.variantId) ?? 0) + i.quantity);
    }
  }
  return holds;
}
