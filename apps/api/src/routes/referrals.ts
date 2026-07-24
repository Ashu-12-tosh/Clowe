import { Router } from 'express';
import type { ReferralView } from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';

export const referralsRouter = Router();
referralsRouter.use(requireAuth);

function maskName(name: string | null, phone: string): string {
  if (name && name.trim()) return name;
  return `+91 ${phone.slice(0, 2)}•••••${phone.slice(-3)}`;
}

// My referral dashboard: code, share text, earnings, referred users.
referralsRouter.get('/me', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!user) throw ApiError.unauthorized();

    const referrals = await prisma.referral.findMany({
      where: { referrerId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { referredUser: { select: { name: true, phone: true } } },
    });

    const body: ReferralView = {
      code: user.referralCode,
      shareText:
        `Shop on Clowe — fashion with AI virtual try-on! ` +
        `Use my referral code ${user.referralCode} when you sign up. 🛍✨`,
      rewardPerReferralPaise: env.REFERRAL_REWARD_PAISE,
      totalEarnedPaise: referrals
        .filter((r) => r.status === 'CREDITED')
        .reduce((sum, r) => sum + r.rewardAmountPaise, 0),
      pendingCount: referrals.filter((r) => r.status === 'PENDING').length,
      referrals: referrals.map((r) => ({
        name: maskName(r.referredUser.name, r.referredUser.phone),
        status: r.status,
        rewardPaise: r.rewardAmountPaise,
        joinedAt: r.createdAt.toISOString(),
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
