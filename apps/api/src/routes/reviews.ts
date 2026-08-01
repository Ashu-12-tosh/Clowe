import { Router } from 'express';
import { reviewCreateSchema, type ReviewItem } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { verifyAccessToken } from '../utils/jwt';

// Mounted under /api/products/:productId/reviews
export const reviewsRouter = Router({ mergeParams: true });

/** mergeParams loses typing — read the parent param explicitly. */
function productIdOf(params: unknown): string {
  return (params as { productId: string }).productId;
}

// Public list (newest first). Marks the caller's own review when logged in.
reviewsRouter.get('/', async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const callerId = token ? (verifyAccessToken(token)?.sub ?? null) : null;

    const reviews = await prisma.review.findMany({
      where: { productId: productIdOf(req.params) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: { select: { id: true, name: true } } },
    });
    const items: ReviewItem[] = reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      userName: r.user.name ?? 'Clowe customer',
      isMine: r.user.id === callerId,
      createdAt: r.createdAt.toISOString(),
    }));
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
});

// Write (or update) my review — one per user per product.
reviewsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const input = reviewCreateSchema.parse(req.body);
    const product = await prisma.product.findUnique({
      where: { id: productIdOf(req.params) },
    });
    if (!product || product.status !== 'APPROVED') throw ApiError.notFound('Product not found');

    await prisma.review.upsert({
      where: { userId_productId: { userId: req.auth!.userId, productId: product.id } },
      update: { rating: input.rating, comment: input.comment ?? null },
      create: {
        userId: req.auth!.userId,
        productId: product.id,
        rating: input.rating,
        comment: input.comment ?? null,
      },
    });

    // Sync the denormalised rating cache the listing/landing pages read.
    const agg = await prisma.review.aggregate({
      where: { productId: product.id },
      _avg: { rating: true },
      _count: { rating: true },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: {
        ratingAvg: Math.round((agg._avg.rating ?? 0) * 10) / 10,
        ratingCount: agg._count.rating,
      },
    });

    res.json({ success: true, data: { saved: true } });
  } catch (err) {
    next(err);
  }
});
