import type { Prisma } from '@prisma/client';
import { prisma } from '../db';

/**
 * One place that decides what an order's status *is*.
 *
 * An order is a bag of lines that different sellers fulfil at their own pace,
 * so `Order.status` is always derived from the lines — never set directly.
 * Both the seller dashboard and the admin order desk call in here, so the two
 * can never disagree about what "Shipped" means.
 */

/** Fulfilment stages in order. Anything outside this is a terminal state. */
export const STAGE_RANK: Record<string, number> = {
  PLACED: 0,
  CONFIRMED: 1,
  PACKED: 2,
  SHIPPED: 3,
  DELIVERED: 4,
};

/** One status for a set of lines. `mixed` is true when they disagree. */
export function aggregateStatus(lines: { status: string }[]): { status: string; mixed: boolean } {
  if (lines.length === 0) return { status: 'CONFIRMED', mixed: false };
  const statuses = new Set(lines.map((l) => l.status));
  if (statuses.has('RETURN_REQUESTED')) {
    return { status: 'RETURN_REQUESTED', mixed: statuses.size > 1 };
  }
  const active = lines.filter((l) => l.status !== 'CANCELLED' && l.status !== 'RETURNED');
  if (active.length === 0) {
    return {
      status: statuses.has('RETURNED') ? 'RETURNED' : 'CANCELLED',
      mixed: statuses.size > 1,
    };
  }
  // The earliest stage still open is the work that is left to do.
  const earliest = active.reduce((min, l) =>
    (STAGE_RANK[l.status] ?? 99) < (STAGE_RANK[min.status] ?? 99) ? l : min,
  );
  return { status: earliest.status, mixed: statuses.size > 1 };
}

/**
 * Roll the item statuses back up to the parent order, so the customer's order
 * list reflects what sellers have done. A multi-vendor order isn't "shipped"
 * until every line has shipped.
 */
export async function syncOrderStatus(orderId: string): Promise<void> {
  const items = await prisma.orderItem.findMany({
    where: { orderId },
    select: { status: true },
  });
  if (items.length === 0) return;
  const { status } = aggregateStatus(items);
  await prisma.order.update({
    where: { id: orderId },
    data: { status: status as Prisma.OrderUpdateInput['status'] },
  });
}

/**
 * COD money changes hands at the door, so its payment row sits at CREATED
 * until delivery. Once every live line of the order is delivered, the cash
 * has been collected — settle it.
 */
export async function settleCodIfDelivered(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      paymentMethod: true,
      payment: { select: { id: true, status: true } },
      items: { select: { status: true } },
    },
  });
  if (!order || order.paymentMethod !== 'COD' || !order.payment) return;
  if (order.payment.status !== 'CREATED') return;

  const live = order.items.filter((i) => i.status !== 'CANCELLED');
  if (live.length === 0 || !live.every((i) => i.status === 'DELIVERED')) return;

  await prisma.payment.update({ where: { id: order.payment.id }, data: { status: 'PAID' } });
}

/**
 * The payment status to *show* for an order. A COD order carries a CREATED
 * payment row until the cash is collected, and reporting that as "Pending"
 * beside a prepaid failure would read like the same thing.
 */
export function displayPaymentStatus(
  paymentMethod: string,
  paymentStatus: string | null | undefined,
): string {
  if (paymentMethod === 'COD' && paymentStatus !== 'PAID' && paymentStatus !== 'REFUNDED') {
    return 'COD_PENDING';
  }
  return paymentStatus ?? 'CREATED';
}
