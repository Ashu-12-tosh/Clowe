import { NOT_A_SALE_STATUSES } from '@clowe/shared';
import type { OrderStatus } from '@prisma/client';
import { prisma } from '../db';
import { creditExpiryFrom } from '../routes/credits';
import { ApiError } from '../utils/ApiError';
import { sendMessageSafe } from './messaging';
import { syncOrderStatus } from './orderStatusService';
import { settleEarnedCredits } from './purchaseCredits';
import { refundCancelledOrder, refundOrderPart } from './refundService';
import { valueOfLines } from './shipping/codAmount';
import { cancelShipmentsForLinesSafe } from './shipping/cancellations';
import { returnStock } from './stockService';

// ---------------------------------------------------------------------------
// Cancelling some or all lines of an order — by the buyer, the seller or an
// admin — one way (Cancellation Policy 1, 3 and 4):
//
// - the lines are CANCELLED and their units go back on the shelf;
// - a booking with the courier is cancelled too;
// - the buyer is refunded the net amount actually paid for those lines
//   (their share of the order total, after coupon and credits, 4.3) — the
//   whole remaining payment when nothing is left on the order;
// - when the order is emptied, its coupon redemption and redeemed credits
//   come back;
// - a seller's or admin's cancellation tells the buyer which lines and why,
//   in the app and by message (3.2), and the line keeps the reason.
// ---------------------------------------------------------------------------

export type CancelledBy = 'CUSTOMER' | 'SELLER' | 'ADMIN';
const NOT_LIVE = new Set<string>(NOT_A_SALE_STATUSES);

export interface LinesCancelled {
  cancelledLines: number;
  emptiedOrder: boolean;
  refund: { id: string; status: string; amountPaise: number } | null;
}

export async function cancelOrderLines(input: {
  orderId: string;
  lineIds: string[];
  /** Only lines in these statuses are cancelled; the rest are left as they are. */
  statuses: OrderStatus[];
  by: CancelledBy;
  actorUserId: string;
  reason: string;
}): Promise<LinesCancelled> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { items: true, user: { select: { phone: true } } } });
  if (!order) throw ApiError.notFound('Order not found');
  const wanted = new Set(input.lineIds);
  const lines = order.items.filter((i) => wanted.has(i.id) && input.statuses.includes(i.status));
  if (lines.length === 0) throw ApiError.badRequest('Nothing here can be cancelled now', 'NOTHING_TO_CANCEL');
  const lineIds = new Set(lines.map((l) => l.id));
  const emptiesOrder = order.items.every((i) => lineIds.has(i.id) || NOT_LIVE.has(i.status));
  const note =
    input.by === 'CUSTOMER' ? 'Order cancelled by customer' : input.by === 'SELLER' ? `Cancelled by seller: ${input.reason}` : `Cancelled by admin: ${input.reason}`;
  // What the buyer paid for these lines, worked out before they change.
  const paidForLines = valueOfLines(order.totalPaise, order.items, lineIds);
  const told = input.by !== 'CUSTOMER';

  const moved = await prisma.$transaction(async (tx) => {
    const { count } = await tx.orderItem.updateMany({
      where: { id: { in: [...lineIds] }, status: { in: input.statuses } },
      data: { status: 'CANCELLED', cancelledBy: input.by, cancelledAt: new Date(), ...(told ? { cancelReason: input.reason } : {}) },
    });
    if (count !== lines.length) return false;
    for (const l of lines) {
      await tx.productVariant.update({ where: { id: l.variantId }, data: { stock: { increment: l.quantity } } });
      await returnStock(tx, { variantId: l.variantId, quantity: l.quantity, reason: note, reference: order.orderNumber, actorId: input.actorUserId });
    }
    if (input.by === 'ADMIN') {
      await tx.order.update({ where: { id: order.id }, data: { adminNote: note } });
    }
    if (emptiesOrder && order.couponCode && order.couponDiscountPaise > 0) {
      await tx.coupon.updateMany({ where: { code: order.couponCode, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
    }
    if (emptiesOrder && order.creditsUsed > 0) {
      await tx.user.update({ where: { id: order.userId }, data: { creditsBalance: { increment: order.creditsUsed } } });
      await tx.creditLedger.create({
        data: { userId: order.userId, delta: order.creditsUsed, reason: 'REFUND_CREDITS', orderId: order.id, expiresAt: creditExpiryFrom() },
      });
    }
    return true;
  });
  // Someone else moved one of the lines first (shipped, or cancelled): nothing changed.
  if (!moved) throw new ApiError(409, 'ORDER_CHANGED', 'This order changed just now — refresh and try again');

  await syncOrderStatus(order.id);
  await cancelShipmentsForLinesSafe([...lineIds]);
  const refund = emptiesOrder
    ? await refundCancelledOrder(order.id, note, input.by === 'ADMIN' ? input.actorUserId : undefined)
    : await refundOrderPart(order.id, paidForLines, note);
  await settleEarnedCredits(order.id);

  if (told) {
    const what = lines.map((l) => `"${l.title}"`).join(', ');
    const whom = input.by === 'SELLER' ? 'the seller' : 'Clowe';
    const money = refund ? ` ₹${(refund.amountPaise / 100).toLocaleString('en-IN')} is being refunded to how you paid.` : '';
    await prisma.notification.create({
      data: {
        userId: order.userId,
        type: 'ORDER_CANCELLED',
        title: emptiesOrder ? `Order ${order.orderNumber} cancelled by ${whom}` : `Part of order ${order.orderNumber} cancelled by ${whom}`,
        body: `${what} — ${input.reason}.${money}`,
        linkHref: `/account/orders/${order.id}`,
      },
    });
    sendMessageSafe({
      channel: 'sms',
      to: `+91${order.user.phone}`,
      body: `Clowe: ${what} in order ${order.orderNumber} was cancelled by ${whom} — ${input.reason}.${money}`,
    });
  }
  return { cancelledLines: lines.length, emptiedOrder: emptiesOrder, refund };
}
