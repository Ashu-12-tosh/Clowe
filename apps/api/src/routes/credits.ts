import { Router } from 'express';
import {
  CREDIT_EARN_PAISE_PER_CREDIT,
  CREDIT_VALUE_PAISE,
  creditsToPaise,
  type CreditsInfo,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';

export const creditsRouter = Router();
creditsRouter.use(requireAuth);

// My shopping credits: balance, rupee value and recent history.
creditsRouter.get('/', async (req, res, next) => {
  try {
    const [user, ledger] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.auth!.userId },
        select: { creditsBalance: true },
      }),
      prisma.creditLedger.findMany({
        where: { userId: req.auth!.userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { order: { select: { orderNumber: true } } },
      }),
    ]);
    const balance = user?.creditsBalance ?? 0;
    const body: CreditsInfo = {
      balance,
      valuePaise: creditsToPaise(balance),
      creditValuePaise: CREDIT_VALUE_PAISE,
      earnPaisePerCredit: CREDIT_EARN_PAISE_PER_CREDIT,
      ledger: ledger.map((row) => ({
        id: row.id,
        delta: row.delta,
        reason: row.reason,
        orderNumber: row.order?.orderNumber ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
