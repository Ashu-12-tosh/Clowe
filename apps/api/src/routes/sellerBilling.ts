import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { invoiceFor, invoiceList } from '../services/sellerInvoice';
import { walletView } from '../services/wallet';
import { listFeeChanges } from '../services/feeChanges';
import { blockSuspendedWrites, requireSeller } from './seller';
import { getCommercial } from '../services/commercial';
import { changePlan, ensureSubscription, pickLiveProducts, setAutoRenew } from '../services/planService';
import {
  sellerAutoRenewSchema,
  sellerLiveProductsSchema,
  sellerPlanChangeSchema,
  type SellerPlanView,
} from '@clowe/shared';

// ---------------------------------------------------------------------------
// A seller's billing with Clowe (owner's Batch 2): the Seller Wallet (topped
// up through /api/seller/promotion-credits/purchase), advertising credit, and
// Clowe's monthly tax invoices.
// ---------------------------------------------------------------------------

export const sellerBillingRouter = Router();
sellerBillingRouter.use(requireAuth, requireSeller);

// Fee changes announced and not yet in effect.
sellerBillingRouter.get('/fee-changes', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await listFeeChanges(true) });
  } catch (err) {
    next(err);
  }
});

sellerBillingRouter.get('/wallet', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const recent = await prisma.sellerLedgerEntry.findMany({
      where: { sellerId, bucket: { in: ['PROMOTION', 'AD_CREDIT'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, type: true, bucket: true, amountPaise: true, note: true, createdAt: true },
    });
    res.json({
      success: true,
      data: { ...(await walletView(sellerId)), recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) },
    });
  } catch (err) {
    next(err);
  }
});

// --- Plans ---------------------------------------------------------------------

sellerBillingRouter.get('/plan', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const [sub, c, wallet, live, hidden] = await Promise.all([
      ensureSubscription(sellerId),
      getCommercial(),
      walletView(sellerId),
      prisma.product.count({ where: { sellerId, status: 'APPROVED', isVisible: true, planHidden: false } }),
      prisma.product.count({ where: { sellerId, planHidden: true } }),
    ]);
    const body: SellerPlanView = {
      plan: sub.plan,
      autoRenew: sub.autoRenew,
      periodStart: sub.periodStart?.toISOString() ?? null,
      periodEnd: sub.periodEnd?.toISOString() ?? null,
      pendingPlan: sub.pendingPlan,
      graceUntil: sub.graceUntil?.toISOString() ?? null,
      limitGraceUntil: sub.limitGraceUntil?.toISOString() ?? null,
      liveProducts: live,
      hiddenByPlan: hidden,
      walletPaise: wallet.walletPaise,
      gstPercent: c.fees.gstPercent,
      plans: { FREE: c.plans.FREE, GROWTH: c.plans.GROWTH, PRO: c.plans.PRO, PREMIUM: c.plans.PREMIUM },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

sellerBillingRouter.post('/plan', blockSuspendedWrites, async (req, res, next) => {
  try {
    const { plan } = sellerPlanChangeSchema.parse(req.body);
    await changePlan(req.seller!.id, plan);
    res.json({ success: true, data: { plan } });
  } catch (err) {
    next(err);
  }
});

sellerBillingRouter.post('/plan/auto-renew', async (req, res, next) => {
  try {
    const { autoRenew } = sellerAutoRenewSchema.parse(req.body);
    await setAutoRenew(req.seller!.id, autoRenew);
    res.json({ success: true, data: { autoRenew } });
  } catch (err) {
    next(err);
  }
});

// The products, for choosing which stay live within the plan's limit.
sellerBillingRouter.get('/plan/products', async (req, res, next) => {
  try {
    const rows = await prisma.product.findMany({
      where: { sellerId: req.seller!.id, status: 'APPROVED', isVisible: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, planHidden: true, createdAt: true },
    });
    res.json({ success: true, data: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) });
  } catch (err) {
    next(err);
  }
});

sellerBillingRouter.post('/plan/live-products', blockSuspendedWrites, async (req, res, next) => {
  try {
    const { productIds } = sellerLiveProductsSchema.parse(req.body);
    await pickLiveProducts(req.seller!.id, productIds);
    res.json({ success: true, data: { live: productIds.length } });
  } catch (err) {
    next(err);
  }
});

sellerBillingRouter.get('/invoices', async (req, res, next) => {
  try {
    res.json({ success: true, data: await invoiceList(req.seller!.id) });
  } catch (err) {
    next(err);
  }
});

sellerBillingRouter.get('/invoices/:month', async (req, res, next) => {
  try {
    res.json({ success: true, data: await invoiceFor(req.seller!.id, req.params.month) });
  } catch (err) {
    next(err);
  }
});
