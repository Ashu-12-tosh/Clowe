import { randomInt } from 'node:crypto';
import { creditsEarnedFor, creditsToPaise, REFERRAL_REWARD_CREDITS } from '@clowe/shared';
import { prisma } from '../db';
import { sendMessageSafe, sendToUserSafe } from './messaging';

/** Human-friendly unique order number, e.g. CLW-2026-482913. */
export async function generateOrderNumber(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `CLW-${new Date().getFullYear()}-${randomInt(0, 1_000_000)
      .toString()
      .padStart(6, '0')}`;
    const exists = await prisma.order.findUnique({ where: { orderNumber: candidate } });
    if (!exists) return candidate;
  }
  throw new Error('Could not generate a unique order number');
}

/**
 * Settle a successful payment: mark PAID, confirm the order + items,
 * clear the buyer's cart, notify buyer and sellers. Idempotent.
 */
export async function settlePaymentSuccess(orderId: string, providerPaymentId?: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true, items: true },
  });
  if (!order || !order.payment) return;
  if (order.payment.status === 'PAID') return; // already settled (webhook + verify race)

  await prisma.$transaction([
    prisma.payment.update({
      where: { id: order.payment.id },
      data: { status: 'PAID', providerPaymentId: providerPaymentId ?? null },
    }),
    prisma.order.update({ where: { id: order.id }, data: { status: 'CONFIRMED' } }),
    prisma.orderItem.updateMany({
      where: { orderId: order.id },
      data: { status: 'CONFIRMED' },
    }),
    prisma.cartItem.deleteMany({ where: { cart: { userId: order.userId } } }),
    prisma.notification.create({
      data: {
        userId: order.userId,
        type: 'ORDER_CONFIRMED',
        title: 'Order confirmed 🎉',
        body: `Payment received for ${order.orderNumber}. We'll update you when it ships.`,
      },
    }),
  ]);

  // Shopping credits: 1 credit per ₹20 actually paid (1 credit = 50 paise).
  const earned = creditsEarnedFor(order.totalPaise);
  if (earned > 0) {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: order.userId },
        data: { creditsBalance: { increment: earned } },
      }),
      prisma.creditLedger.create({
        data: { userId: order.userId, delta: earned, reason: 'EARN_PURCHASE', orderId: order.id },
      }),
      prisma.notification.create({
        data: {
          userId: order.userId,
          type: 'CREDITS_EARNED',
          title: `You earned ${earned} Clowe Credits 🪙`,
          body: `${order.orderNumber} earned you ${earned} credits (worth ₹${(creditsToPaise(earned) / 100).toFixed(2)}). Use them as a discount on your next order!`,
        },
      }),
    ]);
  }

  // Tell each seller they have a new order.
  const sellerIds = [...new Set(order.items.map((i) => i.sellerId))];
  const sellers = await prisma.sellerProfile.findMany({
    where: { id: { in: sellerIds } },
    select: { userId: true },
  });
  await prisma.notification.createMany({
    data: sellers.map((s) => ({
      userId: s.userId,
      type: 'NEW_ORDER',
      title: 'New order received 🛍',
      body: `You have new items to ship in order ${order.orderNumber}.`,
    })),
  });

  // WhatsApp order confirmation (provider-agnostic; mock logs in dev).
  const buyer = await prisma.user.findUnique({ where: { id: order.userId } });
  if (buyer) {
    sendMessageSafe({
      channel: 'whatsapp',
      to: `+91${buyer.phone}`,
      body:
        `Hi ${buyer.name ?? 'there'}! Your Clowe order ${order.orderNumber} is confirmed 🎉 ` +
        `(${order.items.length} item${order.items.length > 1 ? 's' : ''}, ₹${(order.totalPaise / 100).toLocaleString('en-IN')}). ` +
        `Track it any time: /track`,
    });
  }

  await creditReferralIfFirstPaidOrder(order.userId);
}

/**
 * Referral reward: when a referred user's FIRST paid order is confirmed,
 * credit the referrer (amount from REFERRAL_REWARD_PAISE) and notify them.
 */
async function creditReferralIfFirstPaidOrder(userId: string) {
  const referral = await prisma.referral.findUnique({
    where: { referredUserId: userId },
    include: { referrer: { select: { id: true, phone: true, name: true } } },
  });
  if (!referral || referral.status !== 'PENDING') return;

  // The just-confirmed order is included in this count.
  const paidOrders = await prisma.order.count({
    where: { userId, status: { in: ['CONFIRMED', 'SHIPPED', 'DELIVERED'] } },
  });
  if (paidOrders !== 1) return;

  // Reward = 100 Clowe Credits, spendable on the referrer's next order.
  const rewardCredits = REFERRAL_REWARD_CREDITS;
  const rewardValuePaise = creditsToPaise(rewardCredits);
  await prisma.$transaction([
    prisma.referral.update({
      where: { id: referral.id },
      data: { status: 'CREDITED', rewardAmountPaise: rewardValuePaise, creditedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: referral.referrer.id },
      data: { creditsBalance: { increment: rewardCredits } },
    }),
    prisma.creditLedger.create({
      data: { userId: referral.referrer.id, delta: rewardCredits, reason: 'EARN_REFERRAL' },
    }),
    prisma.notification.create({
      data: {
        userId: referral.referrer.id,
        type: 'REFERRAL_CREDITED',
        title: `Referral reward: ${rewardCredits} Clowe Credits! 🎁`,
        body: `Someone you referred just placed their first order — ${rewardCredits} credits (₹${rewardValuePaise / 100}) added. Use them as a discount on your next order.`,
      },
    }),
  ]);
  // Marketing-ish message — respects the referrer's WhatsApp preference.
  sendToUserSafe(referral.referrer.id, {
    channel: 'whatsapp',
    to: `+91${referral.referrer.phone}`,
    body: `Great news ${referral.referrer.name ?? ''}! Your Clowe referral just placed their first order. ${rewardCredits} Clowe Credits (₹${rewardValuePaise / 100}) credited 🎁`,
  });
}

/**
 * Fail/cancel an unpaid order and put reserved stock back. Idempotent.
 */
export async function settlePaymentFailure(orderId: string, reason: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true, items: true },
  });
  if (!order || !order.payment) return;
  if (order.payment.status !== 'CREATED') return; // only unpaid orders can fail

  await prisma.$transaction([
    prisma.payment.update({
      where: { id: order.payment.id },
      data: { status: 'FAILED', failureReason: reason },
    }),
    prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } }),
    prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { status: 'CANCELLED' } }),
    // Restore reserved stock.
    ...order.items.map((item) =>
      prisma.productVariant.update({
        where: { id: item.variantId },
        data: { stock: { increment: item.quantity } },
      }),
    ),
    // Give back any credits that were reserved for the discount.
    ...(order.creditsUsed > 0
      ? [
          prisma.user.update({
            where: { id: order.userId },
            data: { creditsBalance: { increment: order.creditsUsed } },
          }),
          prisma.creditLedger.create({
            data: {
              userId: order.userId,
              delta: order.creditsUsed,
              reason: 'REFUND_CREDITS',
              orderId: order.id,
            },
          }),
        ]
      : []),
  ]);
}
