import { Router } from 'express';
import {
  saveTryOnPhotoSchema,
  tryOnRequestSchema,
  type TryOnHistoryRow,
  type TryOnQuota,
  type TryOnResult,
} from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { tryOnProvider } from '../services/tryon';

export const tryonRouter = Router();
tryonRouter.use(requireAuth);

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
    const body: TryOnQuota = {
      dailyLimit: env.TRYON_DAILY_LIMIT,
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

    // Per-user daily rate limit (successful/pending runs count).
    const used = await usedToday(userId);
    if (used >= env.TRYON_DAILY_LIMIT) {
      throw ApiError.tooMany(
        `Daily try-on limit reached (${env.TRYON_DAILY_LIMIT}/day). Try again tomorrow.`,
        'TRYON_LIMIT',
      );
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
    const garmentImageUrl = product.images[0]?.url;
    if (!garmentImageUrl) throw ApiError.badRequest('This product has no images to try on');

    const record = await prisma.tryOnHistory.create({
      data: {
        userId,
        productId: product.id,
        inputImageUrl: input.photoUrl,
        provider: tryOnProvider.name,
        status: 'PENDING',
      },
    });

    try {
      const resultImageUrl = await tryOnProvider.generate({
        personImageUrl: input.photoUrl,
        garmentImageUrl,
        productTitle: product.title,
      });
      // Cost is logged per successful run — the admin accounting trail.
      const updated = await prisma.tryOnHistory.update({
        where: { id: record.id },
        data: { status: 'SUCCESS', resultImageUrl, costPaise: tryOnProvider.costPaise },
      });
      const body: TryOnResult = {
        id: updated.id,
        status: 'SUCCESS',
        resultImageUrl,
        errorMessage: null,
        provider: tryOnProvider.name,
        costPaise: updated.costPaise,
        remainingToday: Math.max(0, env.TRYON_DAILY_LIMIT - (used + 1)),
      };
      res.json({ success: true, data: body });
    } catch (genErr) {
      const message = genErr instanceof Error ? genErr.message : 'Try-on generation failed';
      await prisma.tryOnHistory.update({
        where: { id: record.id },
        data: { status: 'FAILED', errorMessage: message.slice(0, 500) },
      });
      const body: TryOnResult = {
        id: record.id,
        status: 'FAILED',
        resultImageUrl: null,
        errorMessage: message,
        provider: tryOnProvider.name,
        costPaise: 0,
        remainingToday: Math.max(0, env.TRYON_DAILY_LIMIT - used),
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
    const rows = await prisma.tryOnHistory.findMany({
      where: { userId: req.auth!.userId },
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
      createdAt: r.createdAt.toISOString(),
    }));
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
