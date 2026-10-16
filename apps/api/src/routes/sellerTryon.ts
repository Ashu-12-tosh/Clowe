import { Router } from 'express';
import {
  sellerTryOnAutoRenewSchema,
  sellerTryOnBuySchema,
  sellerTryOnLimitSchema,
  variantLabelOf,
  type SellerTryOnAllocationRow,
  type SellerTryOnMetric,
  type SellerTryOnOverview,
  type SellerTryOnProductRow,
  type SellerTryOnRecentRow,
  istDayKey,
  istStartOfDay,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { blockSuspendedWrites, requireSeller } from './seller';
import { categoryRulesMap } from '../services/categoryRules';
import { getCommercial } from '../services/commercial';
import { buyPack, grantFreeCredits, setPackAutoRenew } from '../services/tryonCredits';

export const sellerTryonRouter = Router();
sellerTryonRouter.use(requireAuth, requireSeller, blockSuspendedWrites);

/** Hard cap on rows pulled into memory for the aggregates. */
const ROW_CAP = 10000;

// Days by the Indian calendar, whatever timezone the server runs in.
function startOfDay(d: Date): Date {
  return istStartOfDay(d);
}

function dayKey(d: Date): string {
  return istDayKey(d);
}

function metric(value: number, previous: number): SellerTryOnMetric {
  const changePercent =
    previous > 0 ? Math.round(((value - previous) / previous) * 1000) / 10 : null;
  return { value, previous, changePercent };
}

/** TR-20260901-AB12 — stable, readable, and free of shopper identity. */
function requestRef(id: string, createdAt: Date): string {
  return `TR-${istDayKey(createdAt).replace(/-/g, '')}-${id.slice(-4).toUpperCase()}`;
}

// GET /api/seller/tryon?days=30 — how shoppers try this seller's products on.
sellerTryonRouter.get('/', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    // Sellers approved before the free grant moved to approval get theirs here.
    await grantFreeCredits(sellerId);
    const c = await getCommercial();
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
    const to = new Date();
    const from = startOfDay(new Date(Date.now() - (days - 1) * 86400000));
    const previousFrom = new Date(from.getTime() - days * 86400000);

    const [rows, prevRows, products, profile, ledger] = await Promise.all([
      prisma.tryOnHistory.findMany({
        where: { product: { sellerId }, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
        take: ROW_CAP,
        select: {
          id: true,
          userId: true,
          productId: true,
          status: true,
          feedback: true,
          variantSize: true,
          variantColor: true,
          createdAt: true,
          product: {
            select: {
              title: true,
              slug: true,
              status: true,
              images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
            },
          },
        },
      }),
      prisma.tryOnHistory.findMany({
        where: { product: { sellerId }, createdAt: { gte: previousFrom, lt: from } },
        take: ROW_CAP,
        select: { userId: true, status: true },
      }),
      prisma.product.findMany({
        where: { sellerId, status: { not: 'ARCHIVED' } },
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          categoryId: true,
          tryOnEnabled: true,
          tryOnLimit: true,
          tryOnUsed: true,
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
        },
      }),
      prisma.sellerProfile.findUnique({
        where: { id: sellerId },
        select: { tryOnCredits: true, tryOnFreeGrant: true, tryOnPackRenewCredits: true, tryOnPackRenewAt: true },
      }),
      prisma.tryOnCreditLedger.findMany({
        where: { sellerId },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { delta: true, reason: true, note: true, createdAt: true },
      }),
    ]);

    // Which of this shop's products can offer try-on at all (category rule)?
    const rules = await categoryRulesMap(products.map((p) => p.categoryId));
    const eligibleProducts = products.filter((p) => rules.get(p.categoryId)?.tryOnEligible);
    const tryOnUnavailable = rows.length === 0 && eligibleProducts.length === 0;

    const allocations: SellerTryOnAllocationRow[] = eligibleProducts.map((p) => ({
      productId: p.id,
      title: p.title,
      slug: p.slug,
      imageUrl: p.images[0]?.url ?? null,
      status: p.status,
      tryOnEnabled: p.tryOnEnabled,
      tryOnLimit: p.tryOnLimit,
      tryOnUsed: p.tryOnUsed,
    }));

    const success = rows.filter((r) => r.status === 'SUCCESS').length;
    const ratedUp = rows.filter((r) => r.feedback === 'UP').length;
    const ratedDown = rows.filter((r) => r.feedback === 'DOWN').length;

    // Daily series over the whole window, zero-filled.
    const trendMap = new Map<string, { total: number; success: number }>();
    for (let i = 0; i < days; i += 1) {
      const d = new Date(from.getTime() + i * 86400000);
      trendMap.set(dayKey(d), { total: 0, success: 0 });
    }
    for (const r of rows) {
      const bucket = trendMap.get(dayKey(r.createdAt));
      if (!bucket) continue;
      bucket.total += 1;
      if (r.status === 'SUCCESS') bucket.success += 1;
    }

    // Per-product interest.
    const byProduct = new Map<string, SellerTryOnProductRow>();
    for (const r of rows) {
      const entry =
        byProduct.get(r.productId) ??
        ({
          productId: r.productId,
          title: r.product.title,
          slug: r.product.slug,
          imageUrl: r.product.images[0]?.url ?? null,
          status: r.product.status,
          runs: 0,
          ratedUp: 0,
          ratedDown: 0,
          lastRunAt: r.createdAt.toISOString(),
        } satisfies SellerTryOnProductRow);
      entry.runs += 1;
      if (r.feedback === 'UP') entry.ratedUp += 1;
      if (r.feedback === 'DOWN') entry.ratedDown += 1;
      if (r.createdAt.toISOString() > entry.lastRunAt) entry.lastRunAt = r.createdAt.toISOString();
      byProduct.set(r.productId, entry);
    }

    const recent: SellerTryOnRecentRow[] = rows.slice(0, 20).map((r) => ({
      ref: requestRef(r.id, r.createdAt),
      productId: r.productId,
      productTitle: r.product.title,
      productSlug: r.product.slug,
      imageUrl: r.product.images[0]?.url ?? null,
      variantLabel: variantLabelOf({
        ...(r.variantColor ? { color: r.variantColor } : {}),
        ...(r.variantSize ? { size: r.variantSize } : {}),
      }),
      status: r.status,
      feedback: r.feedback,
      createdAt: r.createdAt.toISOString(),
    }));

    const body: SellerTryOnOverview = {
      range: { from: from.toISOString(), to: to.toISOString(), days },
      metrics: {
        runs: metric(rows.length, prevRows.length),
        shoppers: metric(
          new Set(rows.map((r) => r.userId)).size,
          new Set(prevRows.map((r) => r.userId)).size,
        ),
        successRatePercent:
          rows.length > 0 ? Math.round((success / rows.length) * 1000) / 10 : 0,
        ratedUp,
        ratedDown,
      },
      trend: [...trendMap.entries()].map(([date, t]) => ({ date, ...t })),
      topProducts: [...byProduct.values()]
        .sort((a, b) => b.runs - a.runs)
        .slice(0, 10),
      recent,
      tryOnUnavailable,
      credits: {
        balance: profile?.tryOnCredits ?? 0,
        freeGrant: profile?.tryOnFreeGrant ?? false,
        ledger: ledger.map((l) => ({
          delta: l.delta,
          reason: l.reason,
          note: l.note,
          createdAt: l.createdAt.toISOString(),
        })),
        packs: c.tryon.packs,
        monthlyPackCredits: profile?.tryOnPackRenewCredits ?? null,
        renewsAt: profile?.tryOnPackRenewAt?.toISOString() ?? null,
        expiryDays: c.tryon.expiryDays,
        extraCreditPaise: c.tryon.extraCreditPaise,
        gstPercent: c.fees.gstPercent,
      },
      allocations,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// Cap (or uncap) how many shopper try-ons one product may consume.
sellerTryonRouter.patch('/products/:productId', async (req, res, next) => {
  try {
    const { tryOnLimit } = sellerTryOnLimitSchema.parse(req.body);
    const { count } = await prisma.product.updateMany({
      where: { id: req.params.productId, sellerId: req.seller!.id },
      data: { tryOnLimit },
    });
    if (count === 0) throw ApiError.notFound('Product not found');
    res.json({ success: true, data: { productId: req.params.productId, tryOnLimit } });
  } catch (err) {
    next(err);
  }
});

// Buy a credit pack (owner's Batch 2): paid from the Seller Wallet with GST,
// then the payable balance; once, or renewing monthly on this date.
sellerTryonRouter.post('/buy', async (req, res, next) => {
  try {
    const { credits, autoRenew } = sellerTryOnBuySchema.parse(req.body);
    const p = await buyPack(req.seller!.id, credits, autoRenew);
    res.json({ success: true, data: { balance: p.tryOnCredits, credits, monthlyPackCredits: p.tryOnPackRenewCredits, renewsAt: p.tryOnPackRenewAt?.toISOString() ?? null } });
  } catch (err) {
    next(err);
  }
});

// Change the monthly pack, or stop it (credits: null).
sellerTryonRouter.post('/auto-renew', async (req, res, next) => {
  try {
    const { credits } = sellerTryOnAutoRenewSchema.parse(req.body);
    const p = await setPackAutoRenew(req.seller!.id, credits);
    res.json({ success: true, data: { balance: p.tryOnCredits, monthlyPackCredits: p.tryOnPackRenewCredits, renewsAt: p.tryOnPackRenewAt?.toISOString() ?? null } });
  } catch (err) {
    next(err);
  }
});
