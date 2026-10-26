import { randomInt } from 'node:crypto';
import { creditsEarnedFor, creditsToPaise, newOrderNumber, promiseLabel, REFERRAL_REWARD_CREDITS } from '@clowe/shared';
import { prisma } from '../db';
import { sendMessageSafe, sendToUserSafe } from './messaging';
import { creditExpiryFrom } from '../routes/credits';
import { returnStock } from './stockService';
import { attributeOrder } from './advertising';
import { notifySellersOfNewOrder } from './sellerOrderNotice';

/** A confirmed order credited to the ads its shopper clicked (never blocks the order). */
function attributeAdsSafe(orderId: string) {
  void attributeOrder(orderId).catch((err) => console.error('[clowe-api] ad attribution failed:', err));
}

/** Unique order number for a new order, e.g. CLW-7KQ3MX9P2T (random, not in sequence). */
export async function generateOrderNumber(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = newOrderNumber(randomInt);
    const exists = await prisma.order.findUnique({ where: { orderNumber: candidate } });
    if (!exists) return candidate;
  }
  throw new Error('Could not generate a unique order number');
}

/** What settling a successful payment did. */
export type SettleSuccessResult =
  /** This call marked it PAID and confirmed the order. */
  | 'SETTLED'
  /** It was already PAID (the webhook and the browser raced; one of them won). */
  | 'ALREADY_PAID'
  /** The order had already been cancelled for want of payment: the money arrived late. */
  | 'LATE'
  /** No such order or payment. */
  | 'MISSING';

/**
 * Settle a successful payment: mark PAID, confirm the order + items,
 * clear the buyer's cart, notify buyer and sellers. Idempotent and safe to
 * race: the payment row is claimed with a conditional update (CREATED → PAID)
 * inside the transaction, so of two callers arriving together exactly one
 * goes on to grant credits, rewards and notifications.
 */
export async function settlePaymentSuccess(orderId: string, providerPaymentId?: string): Promise<SettleSuccessResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true, items: true },
  });
  if (!order || !order.payment) return 'MISSING';
  if (order.payment.status === 'PAID' || order.payment.status === 'REFUNDED') return 'ALREADY_PAID';
  if (order.payment.status === 'FAILED') return 'LATE';
  const paymentId = order.payment.id;

  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.payment.updateMany({
      where: { id: paymentId, status: 'CREATED' },
      data: { status: 'PAID', providerPaymentId: providerPaymentId ?? null, paidAt: new Date() },
    });
    if (claim.count === 0) return false;
    await tx.order.update({ where: { id: order.id }, data: { status: 'CONFIRMED' } });
    await tx.orderItem.updateMany({
      where: { orderId: order.id },
      data: { status: 'CONFIRMED' },
    });
    // Clear only what was actually bought — lines the shopper left unticked
    // stay in the cart. The coupon is spent, so it comes off too.
    await tx.cartItem.deleteMany({
      where: {
        cart: { userId: order.userId },
        variantId: { in: order.items.map((i) => i.variantId) },
      },
    });
    await tx.cart.updateMany({ where: { userId: order.userId }, data: { couponCode: null } });
    await tx.notification.create({
      data: {
        userId: order.userId,
        type: 'ORDER_CONFIRMED',
        title: 'Order confirmed 🎉',
        body: `Payment received for ${order.orderNumber}.${await promiseSentence(order.id, tx)} We'll update you when it ships.`,
        linkHref: `/orders/${order.id}/confirmation`,
      },
    });
    return true;
  });
  if (!claimed) {
    // Someone else moved it first: report what it is now.
    const now = await prisma.payment.findUnique({ where: { id: paymentId }, select: { status: true } });
    return now?.status === 'FAILED' ? 'LATE' : 'ALREADY_PAID';
  }

  attributeAdsSafe(order.id);

  // Shopping credits: 1 credit per ₹20 actually paid (1 credit = 50 paise).
  const earned = creditsEarnedFor(order.totalPaise);
  if (earned > 0) {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: order.userId },
        data: { creditsBalance: { increment: earned } },
      }),
      prisma.creditLedger.create({
        data: {
          userId: order.userId,
          delta: earned,
          reason: 'EARN_PURCHASE',
          orderId: order.id,
          expiresAt: creditExpiryFrom(),
        },
      }),
      prisma.notification.create({
        data: {
          userId: order.userId,
          type: 'CREDITS_EARNED',
          title: `You earned ${earned} Clowe Credits 🪙`,
          linkHref: '/account/credits',
          body: `${order.orderNumber} earned you ${earned} credits (worth ₹${(creditsToPaise(earned) / 100).toFixed(2)}). Use them as a discount on your next order!`,
        },
      }),
    ]);
  }

  // Tell each seller they have a new order: the bell and an email.
  await notifySellersOfNewOrder(order, false);

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
  return 'SETTLED';
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
    where: { userId, status: { in: ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED'] } },
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
      data: {
        userId: referral.referrer.id,
        delta: rewardCredits,
        reason: 'EARN_REFERRAL',
        expiresAt: creditExpiryFrom(),
      },
    }),
    prisma.notification.create({
      data: {
        userId: referral.referrer.id,
        type: 'REFERRAL_CREDITED',
        title: `Referral reward: ${rewardCredits} Clowe Credits! 🎁`,
        linkHref: '/account/credits',
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
export async function settlePaymentFailure(orderId: string, reason: string): Promise<boolean> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true, items: true },
  });
  if (!order || !order.payment) return false;
  if (order.payment.status !== 'CREATED') return false; // only unpaid orders can fail
  const paymentId = order.payment.id;

  // Claimed with a conditional update, like a success: a payment that turned
  // PAID a moment ago is never cancelled, and stock is never returned twice.
  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.payment.updateMany({
      where: { id: paymentId, status: 'CREATED' },
      data: { status: 'FAILED', failureReason: reason },
    });
    if (claim.count === 0) return false;
    await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    await tx.orderItem.updateMany({ where: { orderId: order.id }, data: { status: 'CANCELLED' } });
    // Restore reserved stock.
    for (const item of order.items) {
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { stock: { increment: item.quantity } },
      });
    }
    // Release the coupon redemption reserved at checkout.
    if (order.couponCode && order.couponDiscountPaise > 0) {
      await tx.coupon.updateMany({
        where: { code: order.couponCode, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
    }
    // Give back any credits that were reserved for the discount.
    if (order.creditsUsed > 0) {
      await tx.user.update({
        where: { id: order.userId },
        data: { creditsBalance: { increment: order.creditsUsed } },
      });
      await tx.creditLedger.create({
        data: {
          userId: order.userId,
          delta: order.creditsUsed,
          reason: 'REFUND_CREDITS',
          orderId: order.id,
          expiresAt: creditExpiryFrom(),
        },
      });
    }
    return true;
  });
  if (!claimed) return false;

  // Reserved units are back on the variant; return them to the warehouse they
  // were allocated from so the location rows stay in step.
  await prisma.$transaction(async (tx) => {
    for (const item of order.items) {
      await returnStock(tx, {
        variantId: item.variantId,
        quantity: item.quantity,
        reason: `Payment failed: ${reason}`,
        reference: order.orderNumber,
      });
    }
  });
  return true;
}

/**
 * Confirm a Cash-on-Delivery order. Same downstream effects as a paid order —
 * cart cleared, sellers notified, credits granted — except the payment row
 * stays CREATED because the courier collects the money on delivery.
 */
export async function confirmCodOrder(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order || order.status !== 'PLACED') return;

  await prisma.$transaction([
    prisma.order.update({ where: { id: order.id }, data: { status: 'CONFIRMED' } }),
    prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { status: 'CONFIRMED' } }),
    prisma.cartItem.deleteMany({
      where: {
        cart: { userId: order.userId },
        variantId: { in: order.items.map((i) => i.variantId) },
      },
    }),
    prisma.cart.updateMany({ where: { userId: order.userId }, data: { couponCode: null } }),
    prisma.notification.create({
      data: {
        userId: order.userId,
        type: 'ORDER_CONFIRMED',
        title: 'Order confirmed 🎉',
        body: `${order.orderNumber} is confirmed.${await promiseSentence(order.id)} Keep ₹${(order.totalPaise / 100).toLocaleString('en-IN')} ready for the courier.`,
        linkHref: `/orders/${order.id}/confirmation`,
      },
    }),
  ]);

  attributeAdsSafe(order.id);

  // Credits are earned the same way as a prepaid order; a cancellation
  // reverses the redeemed credits through the existing cancel path.
  const earned = creditsEarnedFor(order.totalPaise);
  if (earned > 0) {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: order.userId },
        data: { creditsBalance: { increment: earned } },
      }),
      prisma.creditLedger.create({
        data: {
          userId: order.userId,
          delta: earned,
          reason: 'EARN_PURCHASE',
          orderId: order.id,
          expiresAt: creditExpiryFrom(),
        },
      }),
    ]);
  }

  await notifySellersOfNewOrder(order, true);
}

/**
 * " Delivery by Thu, 29 Oct." — or one per shop, " Delivery by Thu, 29 Oct
 * (Shop A); by Mon, 2 Nov (Shop B)." — for the order-confirmed message and
 * its email. Empty when the order kept no promise (placed before them).
 */
async function promiseSentence(orderId: string, db: Pick<typeof prisma, 'orderSellerPromise'> = prisma): Promise<string> {
  const promises = await db.orderSellerPromise.findMany({
    where: { orderId },
    include: { seller: { select: { shopName: true } } },
    orderBy: { deliveryBy: 'asc' },
  });
  if (promises.length === 0) return '';
  if (promises.length === 1) return ` ${promiseLabel(promises[0]!)}.`;
  const parts = promises.map((p, i) => `${i === 0 ? promiseLabel(p) : promiseLabel(p).replace(/^Delivery /, '')} (${p.seller.shopName})`);
  return ` ${parts.join('; ')}.`;
}
