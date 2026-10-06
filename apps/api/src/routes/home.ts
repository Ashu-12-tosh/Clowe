import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  newsletterSubscribeSchema,
  type HomePayload,
  type HomeProductCard,
} from '@clowe/shared';
import { prisma } from '../db';
import { isLiveBrand, liveBrands } from '../services/productSearch';
import { hiddenCategories, linksToHiddenCategory, visibleCategoryWhere } from '../services/foodCategories';

export const homeRouter = Router();

// ---------------------------------------------------------------------------
// Tiny in-memory cache. The homepage is identical for every visitor, so one
// cached payload with a short TTL removes ~10 queries per page view.
// ---------------------------------------------------------------------------

const HOME_CACHE_TTL_MS = 60 * 1000;
let cached: { payload: HomePayload; expiresAt: number } | null = null;

/** Called by the admin content routes after any mutation. */
export function bustHomeCache() {
  cached = null;
}

// ---------------------------------------------------------------------------

const cardInclude = {
  images: { orderBy: { sortOrder: 'asc' as const }, take: 1 },
  variants: { select: { id: true, pricePaise: true, mrpPaise: true, stock: true } },
};

type CardSource = Prisma.ProductGetPayload<{ include: typeof cardInclude }>;

function toCard(p: CardSource): HomeProductCard {
  const minVariant = p.variants.reduce(
    (min, v) => (v.pricePaise < min.pricePaise ? v : min),
    p.variants[0] ?? { id: '', pricePaise: p.basePricePaise, mrpPaise: null, stock: 0 },
  );
  const mrpPaise = p.mrpPaise ?? minVariant.mrpPaise;
  const discountPercent =
    mrpPaise && mrpPaise > minVariant.pricePaise
      ? Math.round(((mrpPaise - minVariant.pricePaise) / mrpPaise) * 100)
      : null;
  const inStock = [...p.variants].sort((a, b) => a.pricePaise - b.pricePaise).find((v) => v.stock > 0);
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    brand: p.brand,
    imageUrl: p.images[0]?.url ?? null,
    pricePaise: minVariant.pricePaise,
    mrpPaise,
    discountPercent,
    ratingAvg: p.ratingCount > 0 ? p.ratingAvg : null,
    ratingCount: p.ratingCount,
    defaultVariantId: inStock?.id ?? null,
    badge: p.isBestSeller ? 'BEST_SELLER' : p.isNew ? 'NEW' : p.isTrending ? 'TRENDING' : null,
  };
}

/** Trending: views + sales over the last 7 days (sales weighted 5×). */
async function trendingCards(): Promise<HomeProductCard[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [viewGroups, saleRows] = await Promise.all([
    prisma.productView.groupBy({
      by: ['productId'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.orderItem.findMany({
      where: { order: { createdAt: { gte: since } } },
      select: { productId: true, quantity: true },
    }),
  ]);

  const score = new Map<string, number>();
  for (const g of viewGroups) score.set(g.productId, g._count._all);
  for (const s of saleRows) score.set(s.productId, (score.get(s.productId) ?? 0) + s.quantity * 5);

  const rankedIds = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  const visible = await visibleCategoryWhere();
  const products = await prisma.product.findMany({
    where: { id: { in: rankedIds.slice(0, 30) }, status: 'APPROVED', isVisible: true, seller: { vacationMode: false }, ...visible },
    include: cardInclude,
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const cards = rankedIds
    .map((id) => byId.get(id))
    .filter((p): p is CardSource => Boolean(p))
    .slice(0, 12)
    .map(toCard);

  // Sparse signals (fresh database) — pad with all-time best sellers.
  if (cards.length < 8) {
    const pad = await prisma.product.findMany({
      where: { status: 'APPROVED', isVisible: true, seller: { vacationMode: false }, ...visible, id: { notIn: cards.map((c) => c.id) } },
      orderBy: { soldCount: 'desc' },
      take: 12 - cards.length,
      include: cardInclude,
    });
    cards.push(...pad.map(toCard));
  }
  return cards;
}

async function buildHomePayload(): Promise<HomePayload> {
  const now = new Date();
  // Closed food categories: their products, their tiles, and any banner or
  // promo that links into them stay off the homepage.
  const hidden = await hiddenCategories();
  const opensHidden = (href: string | null | undefined) => linksToHiddenCategory(href, hidden.slugs);

  const [banners, promoTiles, deal, rootCategories, brands, trending] = await Promise.all([
    prisma.homeBanner.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.promoTile.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.deal.findFirst({
      where: { isActive: true, startAt: { lte: now }, endAt: { gt: now } },
      orderBy: { startAt: 'asc' },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: { product: { include: cardInclude } },
        },
      },
    }),
    prisma.category.findMany({
      where: { isActive: true, parentId: null },
      orderBy: { sortOrder: 'asc' },
    }),
    // Only brands with something live to buy (a backfilled "t shirt" has nothing).
    Promise.all([
      prisma.brand.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      liveBrands(),
    ]).then(([all, live]) => all.filter((b) => isLiveBrand(b, live)).slice(0, 16)),
    trendingCards(),
  ]);

  return {
    banners: banners
      .filter((b) => !opensHidden(b.primaryHref) && !opensHidden(b.secondaryHref))
      .map((b) => ({
      id: b.id,
      headline: b.headline,
      highlight: b.highlight,
      subtext: b.subtext,
      imageUrl: b.imageUrl,
      primaryLabel: b.primaryLabel,
      primaryHref: b.primaryHref,
      secondaryLabel: b.secondaryLabel,
      secondaryHref: b.secondaryHref,
    })),
    promoCards: promoTiles
      .filter((t) => t.placement === 'PROMO_CARD' && !opensHidden(t.href))
      .map((t) => ({ id: t.id, title: t.title, subtitle: t.subtitle, imageUrl: t.imageUrl, href: t.href })),
    deal: deal
      ? {
          id: deal.id,
          title: deal.title,
          endsAt: deal.endAt.toISOString(),
          products: deal.items
            .filter((i) => i.product.status === 'APPROVED' && !hidden.ids.has(i.product.categoryId))
            .map((i) => toCard(i.product)),
        }
      : null,
    categories: rootCategories
      .filter((c) => !hidden.ids.has(c.id))
      .map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      icon: c.icon,
      imageUrl: c.imageUrl,
    })),
    trending,
    promoStrips: promoTiles
      .filter((t) => t.placement === 'PROMO_STRIP' && !opensHidden(t.href))
      .map((t) => ({ id: t.id, title: t.title, subtitle: t.subtitle, imageUrl: t.imageUrl, href: t.href })),
    brands: brands.map((b) => ({ id: b.id, name: b.name, slug: b.slug, logoUrl: b.logoUrl })),
  };
}

// Aggregated landing payload, cached for 60s.
homeRouter.get('/', async (_req, res, next) => {
  try {
    if (!cached || cached.expiresAt < Date.now()) {
      cached = { payload: await buildHomePayload(), expiresAt: Date.now() + HOME_CACHE_TTL_MS };
    }
    res.json({ success: true, data: cached.payload });
  } catch (err) {
    next(err);
  }
});

// Newsletter signup (public). Duplicate emails return success with a flag —
// no need to leak "already subscribed" as an error state.
homeRouter.post('/newsletter', async (req, res, next) => {
  try {
    const { email } = newsletterSubscribeSchema.parse(req.body);
    const existing = await prisma.newsletterSubscriber.findUnique({ where: { email } });
    if (existing) {
      res.json({ success: true, data: { subscribed: true, alreadySubscribed: true } });
      return;
    }
    await prisma.newsletterSubscriber.create({ data: { email } });
    res.json({ success: true, data: { subscribed: true, alreadySubscribed: false } });
  } catch (err) {
    next(err);
  }
});
