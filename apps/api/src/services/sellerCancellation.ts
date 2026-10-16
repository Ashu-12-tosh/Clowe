import { NOT_A_SALE_STATUSES, type SellerOrderCancelResult } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { cancelOrderLines } from './lineCancellation';
import { cancelPenaltyKey, postEntry } from './sellerLedgerService';
import { getSettings } from './settingsService';

// ---------------------------------------------------------------------------
// A seller cancelling their part of an order ("can't fulfil"), and the
// penalty for it.
//
// Only lines not yet shipped can be cancelled — all of the seller's, or the
// ones they pick (a partial cancellation, Cancellation Policy 3.1). The buyer
// is told why and refunded what they paid for those lines; if nothing else
// is left on the order it is cancelled whole, exactly as an admin
// cancellation (coupon and credits come back too). The penalty is charged once per order and seller, and only on
// orders placed after the rule took effect. A buyer's or an admin's
// cancellation never charges it: they do not come through here.
// ---------------------------------------------------------------------------

const CANCELLABLE = ['PLACED', 'CONFIRMED', 'PACKED'] as const;
const LIVE_EXCLUDED = new Set<string>(NOT_A_SALE_STATUSES);

/**
 * Charge the seller-cancellation penalty for this order if the rule applies.
 * Returns the amount charged (paise), 0 when nothing was posted — including
 * when it was already charged.
 */
export async function chargeSellerCancelPenalty(
  orderId: string,
  sellerId: string,
  reason: string,
): Promise<number> {
  const settings = await getSettings();
  if (!settings.penaltyEnabled || settings.sellerCancelPenaltyPaise <= 0) return 0;
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { createdAt: true } });
  if (!order) return 0;
  const from = settings.sellerCancelPenaltyEffectiveFrom;
  if (from && order.createdAt.getTime() < new Date(from).getTime()) return 0;
  const posted = await postEntry({
    sellerId,
    type: 'SELLER_CANCEL_PENALTY',
    bucket: 'SETTLEMENT',
    amountPaise: -settings.sellerCancelPenaltyPaise,
    orderId,
    idempotencyKey: cancelPenaltyKey(orderId, sellerId),
    note: `Cancelled by seller: ${reason}`,
  });
  return posted ? settings.sellerCancelPenaltyPaise : 0;
}

export async function cancelSellerPart(input: {
  orderId: string;
  sellerId: string;
  actorUserId: string;
  reason: string;
  /** Only these of the seller's lines; all of them when absent. */
  itemIds?: string[];
}): Promise<SellerOrderCancelResult> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { items: true },
  });
  const mine = order?.items.filter((i) => i.sellerId === input.sellerId) ?? [];
  if (!order || mine.length === 0) throw ApiError.notFound('Order not found');
  if (order.status === 'CANCELLED') throw ApiError.badRequest('This order is already cancelled', 'ALREADY_CANCELLED');

  const picked = input.itemIds ? mine.filter((i) => input.itemIds!.includes(i.id)) : mine;
  if (input.itemIds && picked.length !== input.itemIds.length) throw ApiError.notFound('Item not found on this order');
  const lines = picked.filter((i) => (CANCELLABLE as readonly string[]).includes(i.status));
  if (lines.length === 0) {
    throw ApiError.badRequest(
      picked.some((i) => !LIVE_EXCLUDED.has(i.status))
        ? 'Your items on this order have already shipped — it can’t be cancelled now'
        : 'Nothing of yours on this order is left to cancel',
      'NOTHING_TO_CANCEL',
    );
  }
  // Partial or whole, the buyer is refunded what they paid for these lines
  // and told why (lineCancellation); the penalty is the seller's alone.
  const done = await cancelOrderLines({
    orderId: order.id,
    lineIds: lines.map((l) => l.id),
    statuses: [...CANCELLABLE],
    by: 'SELLER',
    actorUserId: input.actorUserId,
    reason: input.reason,
  });
  // No cancellation penalty any more (owner's Batch 2): the late-dispatch
  // penalty and the admin's penalties are what remain.
  return { cancelledLines: done.cancelledLines, refund: done.refund, penaltyPaise: 0 };
}
