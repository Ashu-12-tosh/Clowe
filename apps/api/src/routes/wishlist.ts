import { Router } from 'express';
import type { WishlistEntry } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';

export const wishlistRouter = Router();

wishlistRouter.use(requireAuth);

// Current user's wishlist, newest first.
wishlistRouter.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.wishlist.findMany({
      where: { userId: req.auth!.userId },
      orderBy: { createdAt: 'desc' },
      include: {
        product: {
          include: {
            category: { select: { name: true } },
            images: { orderBy: { sortOrder: 'asc' }, take: 1 },
            variants: { select: { size: true, color: true, pricePaise: true, mrpPaise: true } },
          },
        },
      },
    });

    const items: WishlistEntry[] = rows
      .filter((row) => row.product.status === 'APPROVED')
      .map((row) => {
        const p = row.product;
        const minVariant = p.variants.reduce(
          (min, v) => (v.pricePaise < min.pricePaise ? v : min),
          p.variants[0] ?? { pricePaise: p.basePricePaise, mrpPaise: null, size: '', color: '' },
        );
        return {
          productId: p.id,
          addedAt: row.createdAt.toISOString(),
          product: {
            id: p.id,
            slug: p.slug,
            title: p.title,
            brand: p.brand,
            categoryName: p.category.name,
            pricePaise: minVariant.pricePaise,
            mrpPaise: minVariant.mrpPaise,
            imageUrl: p.images[0]?.url ?? null,
            sizes: [...new Set(p.variants.map((v) => v.size))],
            colors: [...new Set(p.variants.map((v) => v.color))],
            ratingAvg: null,
            ratingCount: 0,
          },
        };
      });
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
});

// Add a product to the wishlist (idempotent).
wishlistRouter.post('/:productId', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
    if (!product || product.status !== 'APPROVED') throw ApiError.notFound('Product not found');

    await prisma.wishlist.upsert({
      where: { userId_productId: { userId: req.auth!.userId, productId: product.id } },
      update: {},
      create: { userId: req.auth!.userId, productId: product.id },
    });
    res.json({ success: true, data: { added: true } });
  } catch (err) {
    next(err);
  }
});

// Remove a product from the wishlist (idempotent).
wishlistRouter.delete('/:productId', async (req, res, next) => {
  try {
    await prisma.wishlist.deleteMany({
      where: { userId: req.auth!.userId, productId: req.params.productId },
    });
    res.json({ success: true, data: { removed: true } });
  } catch (err) {
    next(err);
  }
});
