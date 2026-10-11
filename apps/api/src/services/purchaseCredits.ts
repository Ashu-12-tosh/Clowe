import { prisma } from '../db';

/**
 * Reward credits follow what was actually bought.
 *
 * An order earns credits when it is paid (or, for COD, when it is placed —
 * see orderService). If its lines are later cancelled or returned, the buyer
 * keeps credits only for the share of the order still bought: earned × (value
 * of lines not cancelled or returned ÷ value of all lines), rounded down.
 * Everything above that is taken back with a REVERSE_PURCHASE entry.
 *
 * Safe to call any number of times, at any step: each call posts only what is
 * still owed, so a full cancellation or full return ends with every earned
 * credit reversed, and a partial return with its share. The balance may go
 * below zero when the credits were already spent — the buyer had their value
 * on an order they did not pay for — and later earnings make it up; checkout
 * never treats a negative balance as a discount.
 */
export async function settleEarnedCredits(orderId: string): Promise<number> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      userId: true,
      orderNumber: true,
      items: { select: { status: true, pricePaise: true, quantity: true } },
      creditLedger: {
        where: { reason: { in: ['EARN_PURCHASE', 'REVERSE_PURCHASE'] } },
        select: { delta: true, reason: true },
      },
    },
  });
  if (!order) return 0;

  const earned = order.creditLedger.filter((e) => e.reason === 'EARN_PURCHASE').reduce((s, e) => s + e.delta, 0);
  if (earned <= 0) return 0;
  const reversed = -order.creditLedger.filter((e) => e.reason === 'REVERSE_PURCHASE').reduce((s, e) => s + e.delta, 0);

  const value = (items: typeof order.items) => items.reduce((s, i) => s + i.pricePaise * i.quantity, 0);
  const allValue = value(order.items);
  const keptValue = value(order.items.filter((i) => i.status !== 'CANCELLED' && i.status !== 'RETURNED'));
  const keep = allValue > 0 ? Math.floor((earned * keptValue) / allValue) : 0;

  const owed = earned - keep - reversed;
  if (owed <= 0) return 0;
  await prisma.$transaction([
    prisma.user.update({ where: { id: order.userId }, data: { creditsBalance: { decrement: owed } } }),
    prisma.creditLedger.create({
      data: { userId: order.userId, delta: -owed, reason: 'REVERSE_PURCHASE', orderId },
    }),
  ]);
  return owed;
}
