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
import { inLockOrder, returnStock } from './stockService';
import { isGatewayName, providerFor } from './payments';
import { syncGatewayPayment, targetOf } from './payments/gatewaySync';

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
const orderChanged = () => new ApiError(409, 'ORDER_CHANGED', 'This order changed just now — refresh and try again');
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
  /** An admin's whole-order cancel tells the buyer the reason alone, not the line titles. */
  wholeOrder?: boolean;
}, gatewayChecked = false): Promise<LinesCancelled> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { items: true, payment: true, user: { select: { phone: true } } },
  });
  if (!order) throw ApiError.notFound('Order not found');
  const wanted = new Set(input.lineIds);
  const lines = order.items.filter((i) => wanted.has(i.id) && input.statuses.includes(i.status));
  if (lines.length === 0) throw ApiError.badRequest('Nothing here can be cancelled now', 'NOTHING_TO_CANCEL');
  const lineIds = new Set(lines.map((l) => l.id));
  // As read before the cancel; decided again under the order's lock below.
  const wouldEmpty = order.items.every((i) => lineIds.has(i.id) || NOT_LIVE.has(i.status));

  // An online order not paid yet: its gateway order is still open, and a
  // payment could land after the cancel (a UPI collect, another tab). It is
  // stopped at the gateway first and its payment closed in the same step as
  // the lines, so the sweeper cannot "cancel" it again (stock and credits back
  // twice) and a late payment is refunded, never revives the order.
  const unpaidOnline = order.payment?.status === 'CREATED' && order.paymentMethod !== 'COD' && isGatewayName(order.payment.provider);
  if (unpaidOnline) {
    if (!wouldEmpty) {
      throw ApiError.badRequest('This order is not paid yet — cancel the whole order instead.', 'CANCEL_WHOLE_UNPAID');
    }
    if (!gatewayChecked) {
      const target = await targetOf('ORDER', order.id);
      const provider = target ? providerFor(target.provider) : null;
      if (target && provider?.terminateOrder && !(await provider.terminateOrder(target.providerOrderId))) {
        // Not stopped: paid, still being paid, or already over (expired) —
        // asking the gateway settles which, and acts on it.
        const now = await syncGatewayPayment(target);
        if (now.outcome === 'FAILED') {
          // Over at the gateway and so cancelled for want of payment just now:
          // there is nothing left to cancel.
          const after = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
          if (after?.status === 'CANCELLED') return { cancelledLines: 0, emptiedOrder: true, refund: null };
        } else if (now.outcome !== 'PAID') {
          throw new ApiError(409, 'PAYMENT_PENDING', 'A payment for this order is with the bank right now. Try cancelling again in a few minutes.');
        }
      }
      // Paid meanwhile, or stopped: look again with what is true now.
      return cancelOrderLines(input, true);
    }
  }
  const note =
    input.by === 'CUSTOMER' ? 'Order cancelled by customer' : input.by === 'SELLER' ? `Cancelled by seller: ${input.reason}` : `Cancelled by admin: ${input.reason}`;
  // What the buyer paid for these lines, worked out before they change.
  const paidForLines = valueOfLines(order.totalPaise, order.items, lineIds);
  const told = input.by !== 'CUSTOMER';

  // One cancellation of this order at a time: two partial cancels arriving
  // together each thought the other's line was still live, so neither saw the
  // order emptied and its credits and coupon never came back.
  const emptiesOrder = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order-cancel:${order.id}`}))`;
    // The payment first, as settling a payment does (payment, then order and
    // lines): the same lock order on both paths, so a cancel and a payment
    // arriving together queue rather than deadlock.
    if (unpaidOnline) {
      const closed = await tx.payment.updateMany({
        where: { orderId: order.id, status: 'CREATED' },
        data: { status: 'FAILED', failureReason: note },
      });
      if (closed.count === 0) throw orderChanged();
    }
    const { count } = await tx.orderItem.updateMany({
      where: { id: { in: [...lineIds] }, status: { in: input.statuses } },
      data: { status: 'CANCELLED', cancelledBy: input.by, cancelledAt: new Date(), ...(told ? { cancelReason: input.reason } : {}) },
    });
    // Someone moved one of the lines first: undo the ones this call moved
    // (a throw rolls the transaction back; returning would keep them).
    if (count !== lines.length) throw orderChanged();
    // Emptied or not is decided here, under the lock, from the lines as they are now.
    const now = await tx.orderItem.findMany({ where: { orderId: order.id }, select: { status: true } });
    const nowEmpty = now.every((i) => NOT_LIVE.has(i.status));
    for (const l of inLockOrder(lines)) {
      await tx.productVariant.update({ where: { id: l.variantId }, data: { stock: { increment: l.quantity } } });
      await returnStock(tx, { variantId: l.variantId, quantity: l.quantity, reason: note, reference: order.orderNumber, actorId: input.actorUserId });
    }
    if (input.by === 'ADMIN') {
      await tx.order.update({ where: { id: order.id }, data: { adminNote: note } });
    }
    if (nowEmpty && order.couponCode && order.couponDiscountPaise > 0) {
      await tx.coupon.updateMany({ where: { code: order.couponCode, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
    }
    if (nowEmpty && order.creditsUsed > 0) {
      await tx.user.update({ where: { id: order.userId }, data: { creditsBalance: { increment: order.creditsUsed } } });
      await tx.creditLedger.create({
        data: { userId: order.userId, delta: order.creditsUsed, reason: 'REFUND_CREDITS', orderId: order.id, expiresAt: creditExpiryFrom() },
      });
    }
    return nowEmpty;
  });

  await syncOrderStatus(order.id);
  await cancelShipmentsForLinesSafe([...lineIds]);
  const refund = emptiesOrder
    ? await refundCancelledOrder(order.id, note, input.by === 'ADMIN' ? input.actorUserId : undefined)
    : await refundOrderPart(order.id, paidForLines, note);
  await settleEarnedCredits(order.id);

  if (told && input.wholeOrder && emptiesOrder) {
    await prisma.notification.create({
      data: {
        userId: order.userId,
        type: 'ORDER_CANCELLED',
        title: `Order ${order.orderNumber} cancelled`,
        body: input.reason,
        linkHref: `/account/orders/${order.id}`,
      },
    });
  } else if (told) {
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
