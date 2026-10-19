import { prisma } from '../db';
import { creditExpiryFrom } from '../routes/credits';

/**
 * Settle a shopper's credit top-up. The purchase row is claimed with a
 * conditional update, so the gateway's webhook and the shopper's browser
 * arriving together grant the credits once.
 *
 * A success may arrive after the purchase was marked FAILED (the payment took
 * longer than the gateway order's lifetime, or the sweeper gave up on it).
 * The money was taken, and a top-up has no stock to give back, so it is
 * honoured: the credits are granted. A failure only ever ends a CREATED one.
 */
export async function settleCreditTopUp(
  purchaseId: string,
  providerPaymentId: string | null,
): Promise<'PAID' | 'FAILED' | 'ALREADY_SETTLED'> {
  if (!providerPaymentId) {
    const failed = await prisma.creditPurchase.updateMany({
      where: { id: purchaseId, status: 'CREATED' },
      data: { status: 'FAILED' },
    });
    return failed.count === 1 ? 'FAILED' : 'ALREADY_SETTLED';
  }

  return prisma.$transaction(async (tx) => {
    const purchase = await tx.creditPurchase.findUnique({ where: { id: purchaseId } });
    if (!purchase) return 'ALREADY_SETTLED';
    const claim = await tx.creditPurchase.updateMany({
      where: { id: purchaseId, status: { in: ['CREATED', 'FAILED'] } },
      data: { status: 'PAID', providerPaymentId },
    });
    if (claim.count === 0) return 'ALREADY_SETTLED';

    const granted = purchase.credits + purchase.bonusCredits;
    await tx.user.update({
      where: { id: purchase.userId },
      data: { creditsBalance: { increment: granted } },
    });
    await tx.creditLedger.create({
      data: { userId: purchase.userId, delta: granted, reason: 'EARN_TOPUP', expiresAt: creditExpiryFrom() },
    });
    await tx.notification.create({
      data: {
        userId: purchase.userId,
        type: 'CREDITS_EARNED',
        title: `${granted} Clowe Credits added 🪙`,
        linkHref: '/account/credits',
        body: `Your top-up of ₹${(purchase.amountPaise / 100).toFixed(2)} is complete.${
          purchase.bonusCredits > 0 ? ` That includes ${purchase.bonusCredits} bonus credits.` : ''
        }`,
      },
    });
    return 'PAID';
  });
}
