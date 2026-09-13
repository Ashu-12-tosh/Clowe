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
import {
  TRYON_MIN_AGE_YEARS,
  TryOnError,
  garmentCategoryFor,
  isSizeBelowTryOnAge,
  isSensitiveForTryOn,
  tryOnProvider,
} from '../services/tryon';
import { getSettings } from '../services/settingsService';
import { categoryRulesFor } from '../services/categoryRules';

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
      include: {
        images: { orderBy: { sortOrder: 'asc' }, take: 1 },
        category: { select: { name: true } },
        variants: { select: { size: true } },
        seller: { select: { id: true, tryOnCredits: true } },
      },
    });
    if (!product || product.status !== 'APPROVED') throw ApiError.notFound('Product not found');

    // Category gate first: try-on is for wearables, whatever the seller toggled.
    const rules = await categoryRulesFor(product.categoryId);
    if (!rules.tryOnEligible) {
      throw ApiError.badRequest(
        'AI Try-On is only available for wearable categories',
        'TRYON_NOT_ELIGIBLE',
      );
    }
    // Never render a shopper in innerwear, swimwear or sleepwear, whatever
    // the category tree says — a mis-filed listing must not be enough.
    if (isSensitiveForTryOn(product.category.name, product.title)) {
      throw ApiError.badRequest(
        'AI Try-On is not available for this kind of product',
        'TRYON_NOT_ELIGIBLE',
      );
    }
    // Kids' clothing is sized by age ("4-5Y"). Below the cut-off we do not
    // render a child wearing the garment, whatever photo was uploaded. The
    // size on screen is what counts; with none sent, the smallest size the
    // listing offers stands in, so omitting it cannot open the gate.
    const sizeUnderTest =
      input.variantSize ??
      product.variants
        .map((v) => v.size)
        .filter(Boolean)
        .sort()[0];
    if (isSizeBelowTryOnAge(sizeUnderTest)) {
      throw ApiError.badRequest(
        `AI Try-On is only available on clothing sized for ages ${TRYON_MIN_AGE_YEARS} and above`,
        'TRYON_NOT_ELIGIBLE',
      );
    }
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

    // Seller-side quota: every run costs the shop one credit, and the seller
    // may cap individual products. Either running out turns try-on off here.
    if (product.seller.tryOnCredits <= 0) {
      throw ApiError.badRequest(
        'AI Try-On is not available on this product right now',
        'TRYON_NOT_ELIGIBLE',
      );
    }
    if (product.tryOnLimit != null && product.tryOnUsed >= product.tryOnLimit) {
      throw ApiError.badRequest(
        'AI Try-On is not available on this product right now',
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
        // Category first, title as the fallback - "Jeans" as a category beats
        // guessing from "Zephyr Slim Fit Stretch" as a title.
        garmentCategory: garmentCategoryFor(product.category.name, product.title),
      });
      // Cost + latency are logged per run — the admin accounting/monitor trail.
      // A successful run also consumes one of the seller's try-on credits and
      // counts against the product's own cap.
      const [updated] = await prisma.$transaction([
        prisma.tryOnHistory.update({
          where: { id: record.id },
          data: {
            status: 'SUCCESS',
            resultImageUrl,
            costPaise: tryOnProvider.costPaise,
            durationMs: Date.now() - startedAt,
          },
        }),
        prisma.sellerProfile.update({
          where: { id: product.seller.id },
          data: { tryOnCredits: { decrement: 1 } },
        }),
        prisma.product.update({
          where: { id: product.id },
          data: { tryOnUsed: { increment: 1 } },
        }),
        prisma.tryOnCreditLedger.create({
          data: {
            sellerId: product.seller.id,
            delta: -1,
            reason: 'RUN',
            note: product.title.slice(0, 80),
          },
        }),
      ]);
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
      // TryOnError carries a message written for the shopper plus a detail for
      // the admin monitor. Anything else is an internal fault: log it in full,
      // but never show its text to a customer.
      const isKnown = genErr instanceof TryOnError;
      const message = isKnown
        ? genErr.message
        : 'AI Try-On could not complete. Please try again in a moment.';
      const detail = isKnown
        ? genErr.detail
        : genErr instanceof Error
          ? `${genErr.name}: ${genErr.message}`
          : String(genErr);
      if (!isKnown) console.error('[clowe-api] try-on failed:', genErr);
      await prisma.tryOnHistory.update({
        where: { id: record.id },
        data: {
          status: 'FAILED',
          errorMessage: detail.slice(0, 500),
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
