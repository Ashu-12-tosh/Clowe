import type { SellerOrderCancelResult } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { syncOrderStatus } from './orderStatusService';
import { settleEarnedCredits } from './purchaseCredits';
import { refundCancelledOrder, refundOrderPart } from './refundService';
import { cancelPenaltyKey, postEntry } from './sellerLedgerService';
import { getSettings } from './settingsService';
import { returnStock } from './stockService';

// ---------------------------------------------------------------------------
// A seller cancelling their part of an order ("can't fulfil"), and the
// penalty for it.
//
// Only lines not yet shipped can be cancelled. The buyer is refunded what
// they paid for those lines; if nothing else is left on the order it is
// cancelled whole, exactly as an admin cancellation (coupon and credits come
// back too). The penalty is charged once per order and seller, and only on
// orders placed after the rule took effect. A buyer's or an admin's
// cancellation never charges it: they do not come through here.
// ---------------------------------------------------------------------------

const CANCELLABLE = ['PLACED', 'CONFIRMED', 'PACKED'] as const;
const LIVE_EXCLUDED = new Set(['CANCELLED', 'RETURNED']);

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
}): Promise<SellerOrderCancelResult> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { items: true },
  });
  const mine = order?.items.filter((i) => i.sellerId === input.sellerId) ?? [];
  if (!order || mine.length === 0) throw ApiError.notFound('Order not found');
  if (order.status === 'CANCELLED') throw ApiError.badRequest('This order is already cancelled', 'ALREADY_CANCELLED');

  const lines = mine.filter((i) => (CANCELLABLE as readonly string[]).includes(i.status));
  if (lines.length === 0) {
    throw ApiError.badRequest(
      mine.some((i) => !LIVE_EXCLUDED.has(i.status))
        ? 'Your items on this order have already shipped — it can’t be cancelled now'
        : 'Nothing of yours on this order is left to cancel',
      'NOTHING_TO_CANCEL',
    );
  }
  const lineIds = new Set(lines.map((l) => l.id));
  // Whether this empties the order: then it is cancelled whole.
  const emptiesOrder = order.items.every((i) => lineIds.has(i.id) || LIVE_EXCLUDED.has(i.status));
  const note = `Cancelled by seller: ${input.reason}`;

  await prisma.$transaction([
    prisma.orderItem.updateMany({
      where: { id: { in: [...lineIds] }, status: { in: [...CANCELLABLE] } },
      data: { status: 'CANCELLED' },
    }),
    // Reserved units go back on the variant; the stock ledger follows below.
    ...lines.map((l) =>
      prisma.productVariant.update({ where: { id: l.variantId }, data: { stock: { increment: l.quantity } } }),
    ),
    ...(emptiesOrder && order.couponCode && order.couponDiscountPaise > 0
      ? [
          prisma.coupon.updateMany({
            where: { code: order.couponCode, usedCount: { gt: 0 } },
            data: { usedCount: { decrement: 1 } },
          }),
        ]
      : []),
    ...(emptiesOrder && order.creditsUsed > 0
      ? [prisma.user.update({ where: { id: order.userId }, data: { creditsBalance: { increment: order.creditsUsed } } })]
      : []),
    prisma.notification.create({
      data: {
        userId: order.userId,
        type: 'ORDER_CANCELLED',
        title: emptiesOrder
          ? `Order ${order.orderNumber} cancelled by the seller`
          : `Part of order ${order.orderNumber} cancelled by the seller`,
        body: `${lines.map((l) => `"${l.title}"`).join(', ')} — ${input.reason}. Anything you paid for ${lines.length === 1 ? 'it' : 'them'} is being refunded.`,
        linkHref: `/account/orders/${order.id}`,
      },
    }),
  ]);

  await prisma.$transaction(async (tx) => {
    for (const l of lines) {
      await returnStock(tx, {
        variantId: l.variantId,
        quantity: l.quantity,
        reason: note,
        reference: order.orderNumber,
        actorId: input.actorUserId,
      });
    }
  });

  await syncOrderStatus(order.id);
  const refund = emptiesOrder
    ? await refundCancelledOrder(order.id, note)
    : await refundOrderPart(
        order.id,
        lines.reduce((sum, l) => sum + l.pricePaise * l.quantity - l.promoDiscountPaise, 0),
        note,
      );
  await settleEarnedCredits(order.id);
  const penaltyPaise = await chargeSellerCancelPenalty(order.id, input.sellerId, input.reason);
  return { cancelledLines: lines.length, refund, penaltyPaise };
}
