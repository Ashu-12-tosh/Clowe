import { Router } from 'express';
import { z } from 'zod';
import {
  AD_SURFACES,
  adCampaignUpdateSchema,
  adClickSchema,
  adImpressionsSchema,
  adPackageBuySchema,
  adReviewSchema,
  cpcCampaignSchema,
  placementBookSchema,
  PLACEMENT_KINDS,
  smartCampaignSchema,
} from '@clowe/shared';
import { prisma } from '../db';
import { optionalAuth, requireAuth, requireRole } from '../middleware/auth';
import { adClickLimiter } from '../middleware/rateLimits';
import {
  adsOverview,
  grantWelcomeCredit,
  availability,
  bookPlacement,
  buyPackage,
  createCpcCampaign,
  createSmartCampaign,
  recordImpressions,
  registerClick,
  reviewCampaign,
  serveAds,
  updateCampaign,
} from '../services/advertising';
import { auditSafe, ipFrom } from '../services/auditService';
import { getCommercial } from '../services/commercial';
import { blockSuspendedWrites, requireSeller } from './seller';

// ---------------------------------------------------------------------------
// Advertising and sponsorship (owner's Batch 2).
//   /api/ad-serve        public: labelled ads for a surface, impressions, clicks
//   /api/seller/advertising  the seller's campaigns, bookings, packages, metrics
//   /api/admin/ad-review the creative approval queue and the booking calendar
// ---------------------------------------------------------------------------

export const adServeRouter = Router();

adServeRouter.get('/', async (req, res, next) => {
  try {
    const q = z
      .object({
        surface: z.enum(AD_SURFACES),
        q: z.string().max(200).optional(),
        categoryId: z.string().max(40).optional(),
        /** Or the category's slug, as the storefront URLs carry it. */
        category: z.string().max(120).optional(),
        productId: z.string().max(40).optional(),
      })
      .parse(req.query);
    const categoryId = q.categoryId ?? (q.category ? (await prisma.category.findUnique({ where: { slug: q.category }, select: { id: true } }))?.id : undefined);
    res.json({ success: true, data: await serveAds(q.surface, { q: q.q, categoryId, productId: q.productId }) });
  } catch (err) {
    next(err);
  }
});

adServeRouter.post('/impressions', async (req, res, next) => {
  try {
    await recordImpressions(adImpressionsSchema.parse(req.body).items);
    res.json({ success: true, data: { ok: true } });
  } catch (err) {
    next(err);
  }
});

adServeRouter.post('/click', adClickLimiter, optionalAuth, async (req, res, next) => {
  try {
    const input = adClickSchema.parse(req.body);
    await registerClick({ ...input, userId: req.auth?.userId ?? null, ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
    // The outcome stays on the server — whether a click counted is not the
    // caller's to learn, or to tune a script against.
    res.json({ success: true, data: { ok: true } });
  } catch (err) {
    next(err);
  }
});

export const sellerAdsRouter = Router();
sellerAdsRouter.use(requireAuth, requireSeller);

/** Rate card, ranges and the seller's balances for the forms. */
sellerAdsRouter.get('/config', async (req, res, next) => {
  try {
    const c = await getCommercial();
    const products = await prisma.product.findMany({
      where: { sellerId: req.seller!.id, status: 'APPROVED', planHidden: false },
      select: { id: true, title: true, categoryId: true },
      orderBy: { title: 'asc' },
    });
    const categories = await prisma.category.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: { ads: c.ads, sponsorship: c.sponsorship, products, categories } });
  } catch (err) {
    next(err);
  }
});

sellerAdsRouter.get('/', async (req, res, next) => {
  try {
    const kind = z.object({ section: z.enum(['advertising', 'sponsorship']).optional() }).parse(req.query).section;
    await grantWelcomeCredit(req.seller!.id);
    res.json({ success: true, data: await adsOverview(req.seller!.id, kind === undefined ? undefined : kind === 'sponsorship') });
  } catch (err) {
    next(err);
  }
});

sellerAdsRouter.get('/availability', async (req, res, next) => {
  try {
    const q = z
      .object({ placement: z.enum(PLACEMENT_KINDS), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.coerce.number().int().min(1).max(92).default(30), categoryId: z.string().optional() })
      .parse(req.query);
    res.json({ success: true, data: await availability(q.placement, q.from, q.days, q.categoryId) });
  } catch (err) {
    next(err);
  }
});

sellerAdsRouter.post('/cpc', blockSuspendedWrites, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await createCpcCampaign(req.seller!.id, cpcCampaignSchema.parse(req.body)) });
  } catch (err) {
    next(err);
  }
});

sellerAdsRouter.post('/smart', blockSuspendedWrites, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await createSmartCampaign(req.seller!.id, smartCampaignSchema.parse(req.body)) });
  } catch (err) {
    next(err);
  }
});

sellerAdsRouter.post('/packages', blockSuspendedWrites, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await buyPackage(req.seller!.id, adPackageBuySchema.parse(req.body)) });
  } catch (err) {
    next(err);
  }
});

sellerAdsRouter.post('/placements', blockSuspendedWrites, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await bookPlacement(req.seller!.id, placementBookSchema.parse(req.body)) });
  } catch (err) {
    next(err);
  }
});

sellerAdsRouter.patch('/:id', blockSuspendedWrites, async (req, res, next) => {
  try {
    res.json({ success: true, data: await updateCampaign(req.seller!.id, req.params.id, adCampaignUpdateSchema.parse(req.body)) });
  } catch (err) {
    next(err);
  }
});

export const adminAdReviewRouter = Router();
adminAdReviewRouter.use(requireAuth, requireRole('ADMIN'));

adminAdReviewRouter.get('/', async (req, res, next) => {
  try {
    const status = z.object({ status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'ENDED', 'PAUSED']).default('PENDING_APPROVAL') }).parse(req.query).status;
    const rows = await prisma.adCampaign.findMany({
      where: { status, kind: 'PLACEMENT' },
      orderBy: { createdAt: status === 'PENDING_APPROVAL' ? 'asc' : 'desc' },
      take: 100,
      include: { seller: { select: { shopName: true } }, product: { select: { title: true, slug: true } }, bookings: { select: { day: true, space: true, scopeKey: true }, orderBy: { day: 'asc' } } },
    });
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        sponsorship: r.sponsorship,
        placement: r.placement,
        status: r.status,
        shopName: r.seller.shopName,
        product: r.product,
        creativeUrl: r.creativeUrl,
        headline: r.headline,
        pricePaise: r.pricePaise,
        rejectionReason: r.rejectionReason,
        days: r.bookings.map((b) => b.day.toISOString().slice(0, 10)),
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** The booking calendar: every booked slot in a date range, by space. */
adminAdReviewRouter.get('/calendar', async (req, res, next) => {
  try {
    const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.coerce.number().int().min(1).max(92).default(31) }).parse(req.query);
    const start = new Date(`${q.from}T00:00:00Z`);
    const end = new Date(start.getTime() + q.days * 86_400_000);
    const rows = await prisma.adSlotBooking.findMany({
      where: { day: { gte: start, lt: end }, campaign: { status: { in: ['ACTIVE', 'PENDING_APPROVAL', 'PAUSED'] } } },
      orderBy: [{ day: 'asc' }, { space: 'asc' }, { slot: 'asc' }],
      include: { campaign: { select: { id: true, name: true, status: true, sponsorship: true, placement: true, seller: { select: { shopName: true } } } } },
    });
    res.json({
      success: true,
      data: rows.map((b) => ({
        day: b.day.toISOString().slice(0, 10),
        space: b.space,
        scopeKey: b.scopeKey,
        slot: b.slot,
        campaignId: b.campaign.id,
        name: b.campaign.name,
        status: b.campaign.status,
        sponsorship: b.campaign.sponsorship,
        placement: b.campaign.placement,
        shopName: b.campaign.seller.shopName,
      })),
    });
  } catch (err) {
    next(err);
  }
});

adminAdReviewRouter.post('/:id', async (req, res, next) => {
  try {
    const input = adReviewSchema.parse(req.body);
    await reviewCampaign(req.params.id, input.action, input.reason);
    auditSafe({
      actorId: req.auth!.userId,
      actorRole: 'ADMIN',
      module: 'ADVERTISING',
      action: input.action === 'approve' ? 'Ad creative approved' : 'Ad creative rejected',
      entityType: 'AdCampaign',
      entityId: req.params.id,
      summary: input.action === 'approve' ? 'Approved an ad creative' : `Rejected an ad creative: ${input.reason}`,
      metadata: { action: input.action },
      ipAddress: ipFrom(req),
    });
    res.json({ success: true, data: { ok: true } });
  } catch (err) {
    next(err);
  }
});
