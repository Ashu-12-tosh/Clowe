import { Router } from 'express';
import { z } from 'zod';
import {
  CREDIT_EARN_PAISE_PER_CREDIT,
  CREDIT_EXPIRY_MONTHS,
  CREDIT_PACKAGES,
  CREDIT_VALUE_PAISE,
  creditsToPaise,
  type CreditPurchaseResult,
  type CreditsInfo,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { paymentProvider } from '../services/payments';

export const creditsRouter = Router();
creditsRouter.use(requireAuth);

/** Expiry stamp for credits earned right now. */
export function creditExpiryFrom(earnedAt = new Date()): Date {
  const expires = new Date(earnedAt);
  expires.setMonth(expires.getMonth() + CREDIT_EXPIRY_MONTHS);
  return expires;
}

/**
 * Walk the ledger oldest → newest, spending against the earliest batches
 * first, and report how much of each surviving batch is still unspent. That
 * makes "expiring soon" exact rather than a guess.
 */
function remainingByBatch(
  rows: { delta: number; expiresAt: Date | null; createdAt: Date }[],
): { expiresAt: Date; credits: number }[] {
  const batches: { expiresAt: Date | null; left: number }[] = [];
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (row.delta > 0) {
      batches.push({ expiresAt: row.expiresAt, left: row.delta });
      continue;
    }
    // A spend eats the oldest batches first.
    let owed = -row.delta;
    for (const batch of batches) {
      if (owed === 0) break;
      const take = Math.min(batch.left, owed);
      batch.left -= take;
      owed -= take;
    }
  }
  return batches
    .filter((b): b is { expiresAt: Date; left: number } => b.expiresAt !== null && b.left > 0)
    .map((b) => ({ expiresAt: b.expiresAt, credits: b.left }))
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
}

const ledgerQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(6),
  type: z.enum(['all', 'earned', 'used']).default('all'),
});

// My shopping credits: balance, totals, expiry outlook and paged history.
creditsRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const query = ledgerQuery.parse(req.query);
    const where = {
      userId,
      ...(query.type === 'earned'
        ? { delta: { gt: 0 } }
        : query.type === 'used'
          ? { delta: { lt: 0 } }
          : {}),
    };

    const [user, allRows, ledgerTotal, ledger] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { creditsBalance: true } }),
      // The full trail drives the FIFO expiry maths and the lifetime totals.
      prisma.creditLedger.findMany({
        where: { userId },
        select: { delta: true, expiresAt: true, createdAt: true },
      }),
      prisma.creditLedger.count({ where }),
      prisma.creditLedger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { order: { select: { orderNumber: true } } },
      }),
    ]);

    const balance = user?.creditsBalance ?? 0;
    const totalEarned = allRows.reduce((sum, r) => (r.delta > 0 ? sum + r.delta : sum), 0);
    const totalUsed = allRows.reduce((sum, r) => (r.delta < 0 ? sum - r.delta : sum), 0);

    const now = Date.now();
    const in30 = now + 30 * 24 * 3600 * 1000;
    const in90 = now + 90 * 24 * 3600 * 1000;
    const batches = remainingByBatch(allRows);
    const expiringIn30Days = batches
      .filter((b) => b.expiresAt.getTime() <= in30)
      .reduce((sum, b) => sum + b.credits, 0);
    const expiringIn90Days = batches
      .filter((b) => b.expiresAt.getTime() <= in90)
      .reduce((sum, b) => sum + b.credits, 0);

    const body: CreditsInfo = {
      balance,
      valuePaise: creditsToPaise(balance),
      creditValuePaise: CREDIT_VALUE_PAISE,
      earnPaisePerCredit: CREDIT_EARN_PAISE_PER_CREDIT,
      totalEarned,
      totalUsed,
      expiringIn30Days,
      expiringIn90Days,
      nextExpiryAt: batches[0]?.expiresAt.toISOString() ?? null,
      expiryMonths: CREDIT_EXPIRY_MONTHS,
      ledger: ledger.map((row) => ({
        id: row.id,
        delta: row.delta,
        reason: row.reason,
        orderNumber: row.order?.orderNumber ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      ledgerTotal,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Top-ups: buy credits through the same gateway orders use
// ---------------------------------------------------------------------------

creditsRouter.get('/packages', (_req, res) => {
  res.json({ success: true, data: CREDIT_PACKAGES });
});

const purchaseSchema = z.object({ packageId: z.string().min(1) });

creditsRouter.post('/purchase', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const { packageId } = purchaseSchema.parse(req.body);
    const pack = CREDIT_PACKAGES.find((p) => p.id === packageId);
    if (!pack) throw ApiError.badRequest('Unknown credit package');

    const purchase = await prisma.creditPurchase.create({
      data: {
        userId,
        packageId: pack.id,
        credits: pack.credits,
        bonusCredits: pack.bonusCredits,
        amountPaise: pack.pricePaise,
        provider: paymentProvider.name,
      },
    });
    const providerOrderId = await paymentProvider.createOrder(
      pack.pricePaise,
      `CREDITS-${purchase.id}`,
    );
    await prisma.creditPurchase.update({ where: { id: purchase.id }, data: { providerOrderId } });

    const body: CreditPurchaseResult = {
      purchaseId: purchase.id,
      credits: pack.credits,
      bonusCredits: pack.bonusCredits,
      amountPaise: pack.pricePaise,
      payment: {
        provider: paymentProvider.name,
        providerOrderId,
        keyId: paymentProvider.publicKeyId,
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

const settleSchema = z.object({ outcome: z.enum(['success', 'failure']) });

/** Dev gateway: settle a top-up without a real payment. */
creditsRouter.post('/purchase/:id/mock-pay', async (req, res, next) => {
  try {
    if (paymentProvider.name !== 'mock') {
      throw ApiError.badRequest('Mock payments are disabled', 'MOCK_DISABLED');
    }
    const userId = req.auth!.userId;
    const { outcome } = settleSchema.parse(req.body);
    const purchase = await prisma.creditPurchase.findFirst({
      where: { id: req.params.id, userId },
    });
    if (!purchase) throw ApiError.notFound('Purchase not found');
    if (purchase.status !== 'CREATED') {
      throw ApiError.badRequest('This purchase is already settled');
    }

    if (outcome === 'failure') {
      await prisma.creditPurchase.update({
        where: { id: purchase.id },
        data: { status: 'FAILED' },
      });
      res.json({ success: true, data: { status: 'FAILED', credits: 0 } });
      return;
    }

    const granted = purchase.credits + purchase.bonusCredits;
    await prisma.$transaction([
      prisma.creditPurchase.update({
        where: { id: purchase.id },
        data: { status: 'PAID', providerPaymentId: `mock_pay_${Date.now()}` },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { creditsBalance: { increment: granted } },
      }),
      prisma.creditLedger.create({
        data: { userId, delta: granted, reason: 'EARN_TOPUP', expiresAt: creditExpiryFrom() },
      }),
      prisma.notification.create({
        data: {
          userId,
          type: 'CREDITS_EARNED',
          title: `${granted} Clowe Credits added 🪙`,
          linkHref: '/account/credits',
          body: `Your top-up of ₹${(purchase.amountPaise / 100).toFixed(2)} is complete.${
            purchase.bonusCredits > 0 ? ` That includes ${purchase.bonusCredits} bonus credits.` : ''
          }`,
        },
      }),
    ]);

    res.json({ success: true, data: { status: 'PAID', credits: granted } });
  } catch (err) {
    next(err);
  }
});
