import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import type { CategoryRules, SharedWishlist, WishlistEntry, WishlistShare } from '@clowe/shared';
import { prisma } from '../db';
import { categoryRulesMap } from '../services/categoryRules';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { listingStockFields, defaultVariantOf } from '../utils/productListing';

export const wishlistRouter = Router();

/** Everything a wishlist card needs, in one include. */
const WISHLIST_INCLUDE = {
  product: {
    include: {
      category: { select: { name: true, slug: true, parent: { select: { name: true, slug: true } } } },
      images: { orderBy: { sortOrder: 'asc' as const }, take: 1 },
      variants: {
        select: {
          id: true,
          size: true,
          color: true,
          pricePaise: true,
          mrpPaise: true,
          stock: true,
        },
      },
    },
  },
} satisfies Prisma.WishlistInclude;

type WishlistRow = Prisma.WishlistGetPayload<{ include: typeof WISHLIST_INCLUDE }>;

function toEntry(row: WishlistRow, rules: Map<string, CategoryRules>): WishlistEntry {
  const p = row.product;
  const cheapest = p.variants.reduce(
    (min, v) => (v.pricePaise < min.pricePaise ? v : min),
    p.variants[0] ?? { pricePaise: p.basePricePaise, mrpPaise: null, size: '', color: '' },
  );
  return {
    productId: p.id,
    addedAt: row.createdAt.toISOString(),
    rootCategorySlug: p.category.parent?.slug ?? p.category.slug,
    rootCategoryName: p.category.parent?.name ?? p.category.name,
    tryOnEligible: (rules.get(p.categoryId)?.tryOnEligible ?? false) && p.tryOnEnabled,
    isBestSeller: p.isBestSeller,
    isNew: p.isNew,
    priceAtAddPaise: row.priceAtAddPaise,
    product: {
      id: p.id,
      slug: p.slug,
      title: p.title,
      brand: p.brand,
      categoryName: p.category.name,
      pricePaise: cheapest.pricePaise,
      mrpPaise: p.mrpPaise ?? cheapest.mrpPaise,
      imageUrl: p.images[0]?.url ?? null,
      sizes: [...new Set(p.variants.map((v) => v.size).filter(Boolean))],
      colors: [...new Set(p.variants.map((v) => v.color).filter(Boolean))],
      ratingAvg: p.ratingCount > 0 ? p.ratingAvg : null,
      ratingCount: p.ratingCount,
      ...listingStockFields(p.variants),
    },
  };
}

async function wishlistFor(userId: string): Promise<WishlistEntry[]> {
  const rows = await prisma.wishlist.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: WISHLIST_INCLUDE,
  });
  const live = rows.filter((row) => row.product.status === 'APPROVED');
  const rules = await categoryRulesMap(live.map((row) => row.product.categoryId));
  return live.map((row) => toEntry(row, rules));
}

// ---------------------------------------------------------------------------
// Public: a wishlist someone shared by link
// ---------------------------------------------------------------------------

wishlistRouter.get('/shared/:token', async (req, res, next) => {
  try {
    const owner = await prisma.user.findUnique({
      where: { wishlistShareToken: req.params.token },
      select: { id: true, name: true },
    });
    if (!owner) throw ApiError.notFound('This wishlist link is no longer available');
    const body: SharedWishlist = {
      ownerName: owner.name ?? 'A Clowe shopper',
      items: await wishlistFor(owner.id),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// Everything below needs a session.
wishlistRouter.use(requireAuth);

// Current user's wishlist, newest first.
wishlistRouter.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await wishlistFor(req.auth!.userId) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/** Create (or reuse) the share link for this wishlist. */
wishlistRouter.post('/share', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { wishlistShareToken: true },
    });
    let token = user?.wishlistShareToken ?? null;
    if (!token) {
      token = randomBytes(12).toString('base64url');
      await prisma.user.update({ where: { id: userId }, data: { wishlistShareToken: token } });
    }
    const body: WishlistShare = { path: `/wishlist/shared/${token}` };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

/** Revoke the link — anyone holding it stops seeing the list. */
wishlistRouter.delete('/share', async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: { wishlistShareToken: null },
    });
    const body: WishlistShare = { path: null };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Move to cart
// ---------------------------------------------------------------------------

async function cartIdFor(userId: string): Promise<string> {
  const existing = await prisma.cart.findUnique({ where: { userId } });
  if (existing) return existing.id;
  return (await prisma.cart.create({ data: { userId } })).id;
}

/**
 * Move saved items into the cart using each product's cheapest in-stock
 * variant. Sold-out items stay in the wishlist and are reported back.
 */
async function moveToCart(userId: string, productIds: string[]) {
  const cartId = await cartIdFor(userId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, status: 'APPROVED' },
    include: { variants: { select: { id: true, pricePaise: true, stock: true } } },
  });

  const movedProductIds: string[] = [];
  const skipped: string[] = [];
  for (const product of products) {
    const variant = defaultVariantOf(product.variants);
    if (!variant) {
      skipped.push(product.title);
      continue;
    }
    const existing = await prisma.cartItem.findUnique({
      where: { cartId_variantId: { cartId, variantId: variant.id } },
    });
    await prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId, variantId: variant.id } },
      update: { quantity: Math.min((existing?.quantity ?? 0) + 1, 10), selected: true },
      create: { cartId, variantId: variant.id, quantity: 1 },
    });
    movedProductIds.push(product.id);
  }

  if (movedProductIds.length > 0) {
    await prisma.wishlist.deleteMany({ where: { userId, productId: { in: movedProductIds } } });
  }
  return { moved: movedProductIds.length, skipped };
}

wishlistRouter.post('/move-to-cart', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const raw = (req.body as { productIds?: unknown }).productIds;
    // No ids given = move the whole wishlist ("Move All to Bag").
    const productIds = Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string')
      : (await wishlistFor(userId)).map((entry) => entry.productId);
    if (productIds.length === 0) throw ApiError.badRequest('Nothing to move');

    const result = await moveToCart(userId, productIds.slice(0, 100));
    res.json({ success: true, data: { ...result, items: await wishlistFor(userId) } });
  } catch (err) {
    next(err);
  }
});

// Add a product to the wishlist (idempotent).
wishlistRouter.post('/:productId', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.productId },
      include: { variants: { select: { id: true, pricePaise: true, stock: true } } },
    });
    if (!product || product.status !== 'APPROVED') throw ApiError.notFound('Product not found');

    // Remember today's price so a later drop can be flagged on the card.
    const cheapest = product.variants.reduce<number | null>(
      (min, v) => (min === null || v.pricePaise < min ? v.pricePaise : min),
      null,
    );
    await prisma.wishlist.upsert({
      where: { userId_productId: { userId: req.auth!.userId, productId: product.id } },
      update: {},
      create: {
        userId: req.auth!.userId,
        productId: product.id,
        priceAtAddPaise: cheapest ?? product.basePricePaise,
      },
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
