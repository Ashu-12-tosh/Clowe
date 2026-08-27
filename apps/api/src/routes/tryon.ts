import { Router } from 'express';
import {
  saveTryOnPhotoSchema,
  tryOnFeedbackSchema,
  tryOnRequestSchema,
  type TryOnFeedback,
  type TryOnDeviceType,
  type TryOnHistoryRow,
  type TryOnQuota,
  type TryOnResult,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { tryOnProvider } from '../services/tryon';
import { getSettings } from '../services/settingsService';

export const tryonRouter = Router();
tryonRouter.use(requireAuth);

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Coarse device bucket from the User-Agent — powers the admin monitor split. */
export function deviceTypeFromUserAgent(ua: string | undefined): TryOnDeviceType {
  if (!ua) return 'OTHER';
  const s = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk|android(?!.*mobile)/.test(s)) return 'TABLET';
  if (/mobi|iphone|ipod|android|blackberry|windows phone/.test(s)) return 'MOBILE';
  if (/windows|macintosh|mac os x|linux|cros/.test(s)) return 'DESKTOP';
  return 'OTHER';
}

async function usedToday(userId: string): Promise<number> {
  // Failed attempts don't count against the daily quota.
  return prisma.tryOnHistory.count({
    where: { userId, createdAt: { gte: startOfToday() }, status: { not: 'FAILED' } },
  });
}

// Current quota + active provider + saved photo (the UI shows both).
tryonRouter.get('/quota', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { tryOnPhotoUrl: true },
    });
    const { tryonDailyLimit } = await getSettings();
    const body: TryOnQuota = {
      dailyLimit: tryonDailyLimit,
      usedToday: await usedToday(req.auth!.userId),
      provider: tryOnProvider.name,
      savedPhotoUrl: user?.tryOnPhotoUrl ?? null,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// Save (or replace) the user's try-on photo — uploaded once, reused after.
tryonRouter.post('/photo', async (req, res, next) => {
  try {
    const { photoUrl } = saveTryOnPhotoSchema.parse(req.body);
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: { tryOnPhotoUrl: photoUrl },
    });
    res.json({ success: true, data: { savedPhotoUrl: photoUrl } });
  } catch (err) {
    next(err);
  }
});

// Remove the saved photo.
tryonRouter.delete('/photo', async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: { tryOnPhotoUrl: null },
    });
    res.json({ success: true, data: { savedPhotoUrl: null } });
  } catch (err) {
    next(err);
  }
});

// Run a try-on: customer photo + product's primary image → provider → result.
tryonRouter.post('/', async (req, res, next) => {
  try {
    const input = tryOnRequestSchema.parse(req.body);
    const userId = req.auth!.userId;

    // Live controls from the admin monitor (kill switch, quota, spend cap).
    const settings = await getSettings();
    if (!settings.tryonEnabled) {
      throw ApiError.badRequest(
        'AI Try-On is temporarily paused. Please check back shortly.',
        'TRYON_DISABLED',
      );
    }

    // Per-user daily rate limit (successful/pending runs count).
    const used = await usedToday(userId);
    if (used >= settings.tryonDailyLimit) {
      throw ApiError.tooMany(
        `Daily try-on limit reached (${settings.tryonDailyLimit}/day). Try again tomorrow.`,
        'TRYON_LIMIT',
      );
    }

    // Monthly provider spend cap — 0 means unlimited.
    if (settings.tryonMonthlyBudgetPaise > 0) {
      const spend = await prisma.tryOnHistory.aggregate({
        _sum: { costPaise: true },
        where: { createdAt: { gte: startOfMonth() } },
      });
      if ((spend._sum.costPaise ?? 0) >= settings.tryonMonthlyBudgetPaise) {
        throw ApiError.tooMany(
          'AI Try-On has hit its monthly budget. Please try again next month.',
          'TRYON_BUDGET',
        );
      }
    }

    // One at a time per user.
    const inFlight = await prisma.tryOnHistory.findFirst({
      where: {
        userId,
        status: 'PENDING',
        createdAt: { gte: new Date(Date.now() - 2 * 60 * 1000) },
      },
    });
    if (inFlight) {
      throw ApiError.tooMany('A try-on is already in progress. Please wait.', 'TRYON_BUSY');
    }

    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } },
    });
    if (!product || product.status !== 'APPROVED') throw ApiError.notFound('Product not found');

    // Try-On is a premium-product feature — threshold set by admin settings.
    if (!product.tryOnEnabled) {
      throw ApiError.badRequest(
        'The seller has turned off AI Try-On for this product',
        'TRYON_NOT_ELIGIBLE',
      );
    }
    if (product.basePricePaise < settings.tryonMinPricePaise) {
      throw ApiError.badRequest(
        `AI Try-On is available on products priced ₹${Math.round(settings.tryonMinPricePaise / 100)} and above`,
        'TRYON_NOT_ELIGIBLE',
      );
    }

    const garmentImageUrl = product.images[0]?.url;
    if (!garmentImageUrl) throw ApiError.badRequest('This product has no images to try on');

    const record = await prisma.tryOnHistory.create({
      data: {
        userId,
        productId: product.id,
        inputImageUrl: input.photoUrl,
        provider: tryOnProvider.name,
        status: 'PENDING',
        variantSize: input.variantSize ?? null,
        variantColor: input.variantColor ?? null,
        deviceType: deviceTypeFromUserAgent(req.get('user-agent')),
      },
    });

    const startedAt = Date.now();
    try {
      const resultImageUrl = await tryOnProvider.generate({
        personImageUrl: input.photoUrl,
        garmentImageUrl,
        productTitle: product.title,
      });
      // Cost + latency are logged per run — the admin accounting/monitor trail.
      const updated = await prisma.tryOnHistory.update({
        where: { id: record.id },
        data: {
          status: 'SUCCESS',
          resultImageUrl,
          costPaise: tryOnProvider.costPaise,
          durationMs: Date.now() - startedAt,
        },
      });
      const body: TryOnResult = {
        id: updated.id,
        status: 'SUCCESS',
        resultImageUrl,
        errorMessage: null,
        provider: tryOnProvider.name,
        costPaise: updated.costPaise,
        remainingToday: Math.max(0, settings.tryonDailyLimit - (used + 1)),
      };
      res.json({ success: true, data: body });
    } catch (genErr) {
      const message = genErr instanceof Error ? genErr.message : 'Try-on generation failed';
      await prisma.tryOnHistory.update({
        where: { id: record.id },
        data: {
          status: 'FAILED',
          errorMessage: message.slice(0, 500),
          durationMs: Date.now() - startedAt,
        },
      });
      const body: TryOnResult = {
        id: record.id,
        status: 'FAILED',
        resultImageUrl: null,
        errorMessage: message,
        provider: tryOnProvider.name,
        costPaise: 0,
        remainingToday: Math.max(0, settings.tryonDailyLimit - used),
      };
      res.json({ success: true, data: body });
    }
  } catch (err) {
    next(err);
  }
});

// My past try-ons.
tryonRouter.get('/history', async (req, res, next) => {
  try {
    const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
    const rows = await prisma.tryOnHistory.findMany({
      where: { userId: req.auth!.userId, ...(productId ? { productId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { product: { select: { title: true, slug: true } } },
    });
    const body: TryOnHistoryRow[] = rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      productTitle: r.product.title,
      productSlug: r.product.slug,
      inputImageUrl: r.inputImageUrl,
      resultImageUrl: r.resultImageUrl,
      status: r.status,
      provider: r.provider,
      feedback: (r.feedback as TryOnFeedback | null) ?? null,
      variantSize: r.variantSize,
      variantColor: r.variantColor,
      createdAt: r.createdAt.toISOString(),
    }));
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// "Happy with the fit?" — the shopper's verdict on one result. Sending null
// clears a previous rating.
tryonRouter.post('/:id/feedback', async (req, res, next) => {
  try {
    const { feedback } = tryOnFeedbackSchema.parse(req.body);
    const { count } = await prisma.tryOnHistory.updateMany({
      where: { id: req.params.id, userId: req.auth!.userId },
      data: { feedback },
    });
    if (count === 0) throw ApiError.notFound('Try-on not found');
    res.json({ success: true, data: { id: req.params.id, feedback } });
  } catch (err) {
    next(err);
  }
});
