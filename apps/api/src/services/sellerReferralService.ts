import { randomBytes } from 'node:crypto';
import { prisma } from '../db';
import { sendToUserSafe } from './messaging';

/** Referred seller's cumulative DELIVERED sales needed for the reward. */
export const SELLER_REFERRAL_TARGET_PAISE = 1500000; // ₹15,000
/** One-time bonus the referrer earns (as Clowe Credits). */
export const SELLER_REFERRAL_REWARD_PAISE = 300000; // ₹3,000

const newCode = () => `SLR-${randomBytes(3).toString('hex').toUpperCase()}`;

/** Get (or lazily create) a seller's SLR-XXXXXX referral code. */
export async function ensureSellerReferralCode(sellerId: string): Promise<string> {
  const profile = await prisma.sellerProfile.findUnique({ where: { id: sellerId } });
  if (!profile) throw new Error('Seller not found');
  if (profile.referralCode) return profile.referralCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const updated = await prisma.sellerProfile.update({
        where: { id: sellerId },
        data: { referralCode: newCode() },
      });
      return updated.referralCode!;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') continue; // code collision — retry
      throw err;
    }
  }
  throw new Error('Could not generate a unique seller referral code');
}

/** Delivered, non-returned sales of a seller (paise). Cancelled/returned never count. */
export async function deliveredSalesPaise(sellerId: string): Promise<number> {
  const items = await prisma.orderItem.findMany({
    where: { sellerId, status: 'DELIVERED' },
    select: { pricePaise: true, quantity: true },
  });
  return items.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
}

/**
 * Called after an item of this seller is DELIVERED: if they were referred,
 * are admin-approved, and their delivered sales just crossed the target,
 * credit the referrer once. Idempotent (status guard).
 */
export async function checkSellerReferralReward(sellerId: string): Promise<void> {
  const referral = await prisma.sellerReferral.findUnique({
    where: { referredId: sellerId },
    include: {
      referred: { select: { shopName: true, status: true } },
      referrer: { include: { user: { select: { id: true, phone: true } } } },
    },
  });
  // Reward only counts once, and only after the referred seller was approved.
  if (!referral || referral.status !== 'PENDING') return;
  if (referral.referred.status !== 'APPROVED') return;

  const sales = await deliveredSalesPaise(sellerId);
  if (sales < SELLER_REFERRAL_TARGET_PAISE) return;

  await prisma.$transaction([
    prisma.sellerReferral.update({
      where: { id: referral.id },
      data: { status: 'EARNED', rewardPaise: SELLER_REFERRAL_REWARD_PAISE, earnedAt: new Date() },
    }),
    prisma.notification.create({
      data: {
        userId: referral.referrer.user.id,
        type: 'SELLER_REFERRAL_EARNED',
        title: 'Referral bonus earned! 🎉',
        body: `"${referral.referred.shopName}" crossed ₹${SELLER_REFERRAL_TARGET_PAISE / 100} in delivered sales — ₹${SELLER_REFERRAL_REWARD_PAISE / 100} Clowe Credits added to your account.`,
      },
    }),
  ]);
  console.log(
    `[clowe-api] SELLER REFERRAL EARNED: ${referral.id} referrer=${referral.referrerId} referred=${referral.referredId} sales=${sales}`,
  );
  sendToUserSafe(referral.referrer.user.id, {
    channel: 'whatsapp',
    to: `+91${referral.referrer.user.phone}`,
    body: `Clowe Seller: your referral "${referral.referred.shopName}" hit ₹${SELLER_REFERRAL_TARGET_PAISE / 100} in sales. ₹${SELLER_REFERRAL_REWARD_PAISE / 100} bonus credited! 🎉`,
  });
}
