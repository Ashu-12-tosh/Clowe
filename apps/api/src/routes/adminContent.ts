// Admin CRUD for marketplace content: brands, hero banners, promo tiles,
// deals of the day, and newsletter subscribers. Mounted under /api/admin
// alongside the main admin router; every mutation busts the homepage cache.
import { Router } from 'express';
import {
  bannerImageProblem,
  bannerUpsertSchema,
  brandUpsertSchema,
  categoryBannerUpsertSchema,
  type AdminCategoryBannerRow,
  dealUpsertSchema,
  promoTileUpsertSchema,
  type AdminBannerRow,
  type AdminBrandRow,
  type AdminDealRow,
  type AdminPromoTileRow,
  type NewsletterSubscriberRow,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { bustHomeCache } from './home';

export const adminContentRouter = Router();

/** Refuse a banner whose image fields don't add up (see bannerImageProblem). */
function assertBannerImage(b: Parameters<typeof bannerImageProblem>[0]) {
  const problem = bannerImageProblem(b);
  if (problem) throw ApiError.invalidField(problem.field, problem.message);
}
adminContentRouter.use(requireAuth, requireRole('ADMIN'));

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

adminContentRouter.get('/brands', async (_req, res, next) => {
  try {
    const brands = await prisma.brand.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    const rows: AdminBrandRow[] = brands.map((b) => ({
      id: b.id,
      name: b.name,
      slug: b.slug,
      logoUrl: b.logoUrl,
      isActive: b.isActive,
      sortOrder: b.sortOrder,
      productCount: b._count.products,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.post('/brands', async (req, res, next) => {
  try {
    const input = brandUpsertSchema.parse(req.body);
    const slug = slugify(input.name);
    if (await prisma.brand.findUnique({ where: { slug } })) {
      throw ApiError.badRequest('A brand with this name already exists');
    }
    const brand = await prisma.brand.create({
      data: {
        name: input.name,
        slug,
        logoUrl: input.logoUrl ?? null,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    bustHomeCache();
    res.json({ success: true, data: { id: brand.id, slug: brand.slug } });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.patch('/brands/:id', async (req, res, next) => {
  try {
    const input = brandUpsertSchema.partial().parse(req.body);
    const brand = await prisma.brand.findUnique({ where: { id: req.params.id } });
    if (!brand) throw ApiError.notFound('Brand not found');
    await prisma.brand.update({
      where: { id: brand.id },
      data: {
        name: input.name,
        logoUrl: input.logoUrl,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      },
    });
    // Keep product brand snapshots in step when the name changes.
    if (input.name && input.name !== brand.name) {
      await prisma.product.updateMany({ where: { brandId: brand.id }, data: { brand: input.name } });
    }
    bustHomeCache();
    res.json({ success: true, data: { id: brand.id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Hero banners
// ---------------------------------------------------------------------------

adminContentRouter.get('/banners', async (_req, res, next) => {
  try {
    const banners = await prisma.homeBanner.findMany({ orderBy: { sortOrder: 'asc' } });
    const rows: AdminBannerRow[] = banners.map((b) => ({
      id: b.id,
      headline: b.headline,
      highlight: b.highlight,
      subtext: b.subtext,
      imageUrl: b.imageUrl,
      primaryLabel: b.primaryLabel,
      primaryHref: b.primaryHref,
      secondaryLabel: b.secondaryLabel,
      secondaryHref: b.secondaryHref,
      imageMode: b.imageMode,
      altText: b.altText,
      mobileImageUrl: b.mobileImageUrl,
      focalX: b.focalX,
      focalY: b.focalY,
      sortOrder: b.sortOrder,
      isActive: b.isActive,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.post('/banners', async (req, res, next) => {
  try {
    const input = bannerUpsertSchema.parse(req.body);
    assertBannerImage(input);
    const banner = await prisma.homeBanner.create({
      data: {
        headline: input.headline,
        highlight: input.highlight ?? null,
        subtext: input.subtext ?? null,
        imageUrl: input.imageUrl ?? null,
        primaryLabel: input.primaryLabel ?? 'Shop Now',
        primaryHref: input.primaryHref ?? '/products',
        secondaryLabel: input.secondaryLabel ?? null,
        secondaryHref: input.secondaryHref ?? null,
        imageMode: input.imageMode ?? 'DESIGNED',
        altText: input.altText || null,
        mobileImageUrl: input.mobileImageUrl || null,
        focalX: input.focalX ?? 50,
        focalY: input.focalY ?? 50,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
      },
    });
    bustHomeCache();
    res.json({ success: true, data: { id: banner.id } });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.patch('/banners/:id', async (req, res, next) => {
  try {
    const input = bannerUpsertSchema.partial().parse(req.body);
    const current = await prisma.homeBanner.findUnique({ where: { id: req.params.id } });
    if (!current) throw ApiError.notFound('Banner not found');
    assertBannerImage({ ...current, ...input });
    await prisma.homeBanner.update({ where: { id: req.params.id }, data: input });
    bustHomeCache();
    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.delete('/banners/:id', async (req, res, next) => {
  try {
    await prisma.homeBanner.delete({ where: { id: req.params.id } }).catch(() => {
      throw ApiError.notFound('Banner not found');
    });
    bustHomeCache();
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Promo tiles
// ---------------------------------------------------------------------------

adminContentRouter.get('/promos', async (_req, res, next) => {
  try {
    const tiles = await prisma.promoTile.findMany({
      orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
    });
    const rows: AdminPromoTileRow[] = tiles.map((t) => ({
      id: t.id,
      placement: t.placement,
      title: t.title,
      subtitle: t.subtitle,
      imageUrl: t.imageUrl,
      href: t.href,
      imageMode: t.imageMode,
      altText: t.altText,
      mobileImageUrl: t.mobileImageUrl,
      focalX: t.focalX,
      focalY: t.focalY,
      sortOrder: t.sortOrder,
      isActive: t.isActive,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.post('/promos', async (req, res, next) => {
  try {
    const input = promoTileUpsertSchema.parse(req.body);
    assertBannerImage(input);
    const tile = await prisma.promoTile.create({
      data: {
        placement: input.placement,
        title: input.title,
        subtitle: input.subtitle ?? null,
        imageUrl: input.imageUrl ?? null,
        href: input.href ?? '/products',
        imageMode: input.imageMode ?? 'DESIGNED',
        altText: input.altText || null,
        mobileImageUrl: input.mobileImageUrl || null,
        focalX: input.focalX ?? 50,
        focalY: input.focalY ?? 50,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
      },
    });
    bustHomeCache();
    res.json({ success: true, data: { id: tile.id } });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.patch('/promos/:id', async (req, res, next) => {
  try {
    const input = promoTileUpsertSchema.partial().parse(req.body);
    const current = await prisma.promoTile.findUnique({ where: { id: req.params.id } });
    if (!current) throw ApiError.notFound('Promo tile not found');
    assertBannerImage({ ...current, ...input });
    await prisma.promoTile.update({ where: { id: req.params.id }, data: input });
    bustHomeCache();
    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.delete('/promos/:id', async (req, res, next) => {
  try {
    await prisma.promoTile.delete({ where: { id: req.params.id } }).catch(() => {
      throw ApiError.notFound('Promo tile not found');
    });
    bustHomeCache();
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Category banners: the carousel on a category's landing page
// ---------------------------------------------------------------------------

function toCategoryBannerRow(
  b: Awaited<ReturnType<typeof prisma.categoryBanner.findFirstOrThrow>> & { category: { name: string } },
): AdminCategoryBannerRow {
  return {
    id: b.id,
    categoryId: b.categoryId,
    categoryName: b.category.name,
    eyebrow: b.eyebrow,
    headline: b.headline,
    highlight: b.highlight,
    subtext: b.subtext,
    imageUrl: b.imageUrl,
    primaryLabel: b.primaryLabel,
    primaryHref: b.primaryHref,
    imageMode: b.imageMode,
    altText: b.altText,
    mobileImageUrl: b.mobileImageUrl,
    focalX: b.focalX,
    focalY: b.focalY,
    sortOrder: b.sortOrder,
    isActive: b.isActive,
  };
}

adminContentRouter.get('/category-banners', async (req, res, next) => {
  try {
    const categoryId = typeof req.query.categoryId === 'string' && req.query.categoryId ? req.query.categoryId : undefined;
    const banners = await prisma.categoryBanner.findMany({
      where: categoryId ? { categoryId } : {},
      orderBy: [{ categoryId: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { category: { select: { name: true } } },
    });
    res.json({ success: true, data: banners.map(toCategoryBannerRow) });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.post('/category-banners', async (req, res, next) => {
  try {
    const input = categoryBannerUpsertSchema.parse(req.body);
    assertBannerImage(input);
    if (!(await prisma.category.findUnique({ where: { id: input.categoryId }, select: { id: true } }))) {
      throw ApiError.badRequest('Category not found');
    }
    const banner = await prisma.categoryBanner.create({
      data: {
        categoryId: input.categoryId,
        eyebrow: input.eyebrow || null,
        headline: input.headline,
        highlight: input.highlight || null,
        subtext: input.subtext || null,
        imageUrl: input.imageUrl ?? null,
        primaryLabel: input.primaryLabel ?? 'Shop Now',
        primaryHref: input.primaryHref || null,
        imageMode: input.imageMode ?? 'DESIGNED',
        altText: input.altText || null,
        mobileImageUrl: input.mobileImageUrl || null,
        focalX: input.focalX ?? 50,
        focalY: input.focalY ?? 50,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
      },
      include: { category: { select: { name: true } } },
    });
    res.json({ success: true, data: toCategoryBannerRow(banner) });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.patch('/category-banners/:id', async (req, res, next) => {
  try {
    const { categoryId, ...input } = categoryBannerUpsertSchema.partial().parse(req.body);
    const current = await prisma.categoryBanner.findUnique({ where: { id: req.params.id } });
    if (!current) throw ApiError.notFound('Category banner not found');
    assertBannerImage({ ...current, ...input });
    if (categoryId && !(await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } }))) {
      throw ApiError.badRequest('Category not found');
    }
    const banner = await prisma.categoryBanner.update({
      where: { id: req.params.id },
      data: {
        ...input,
        ...(categoryId ? { categoryId } : {}),
        ...(input.primaryHref !== undefined ? { primaryHref: input.primaryHref || null } : {}),
      },
      include: { category: { select: { name: true } } },
    });
    res.json({ success: true, data: toCategoryBannerRow(banner) });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.delete('/category-banners/:id', async (req, res, next) => {
  try {
    await prisma.categoryBanner.delete({ where: { id: req.params.id } }).catch(() => {
      throw ApiError.notFound('Category banner not found');
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Deals of the day
// ---------------------------------------------------------------------------

function dealState(startAt: Date, endAt: Date): AdminDealRow['state'] {
  const now = Date.now();
  if (endAt.getTime() <= now) return 'ENDED';
  if (startAt.getTime() > now) return 'UPCOMING';
  return 'LIVE';
}

adminContentRouter.get('/deals', async (_req, res, next) => {
  try {
    const deals = await prisma.deal.findMany({
      orderBy: { startAt: 'desc' },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: {
            product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
          },
        },
      },
    });
    const rows: AdminDealRow[] = deals.map((d) => ({
      id: d.id,
      title: d.title,
      startAt: d.startAt.toISOString(),
      endAt: d.endAt.toISOString(),
      isActive: d.isActive,
      state: dealState(d.startAt, d.endAt),
      products: d.items.map((i) => ({
        id: i.product.id,
        title: i.product.title,
        imageUrl: i.product.images[0]?.url ?? null,
      })),
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.post('/deals', async (req, res, next) => {
  try {
    const input = dealUpsertSchema.parse(req.body);
    if (new Date(input.endAt) <= new Date(input.startAt)) {
      throw ApiError.badRequest('The deal must end after it starts');
    }
    const products = await prisma.product.count({
      where: { id: { in: input.productIds }, status: 'APPROVED' },
    });
    if (products !== input.productIds.length) {
      throw ApiError.badRequest('Every deal product must be a live (approved) product');
    }
    const deal = await prisma.deal.create({
      data: {
        title: input.title ?? 'Deals of the Day',
        startAt: new Date(input.startAt),
        endAt: new Date(input.endAt),
        isActive: input.isActive ?? true,
        items: { create: input.productIds.map((productId, i) => ({ productId, sortOrder: i })) },
      },
    });
    bustHomeCache();
    res.json({ success: true, data: { id: deal.id } });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.patch('/deals/:id', async (req, res, next) => {
  try {
    const input = dealUpsertSchema.partial().parse(req.body);
    const deal = await prisma.deal.findUnique({ where: { id: req.params.id } });
    if (!deal) throw ApiError.notFound('Deal not found');

    const startAt = input.startAt ? new Date(input.startAt) : deal.startAt;
    const endAt = input.endAt ? new Date(input.endAt) : deal.endAt;
    if (endAt <= startAt) throw ApiError.badRequest('The deal must end after it starts');

    await prisma.$transaction([
      prisma.deal.update({
        where: { id: deal.id },
        data: { title: input.title, startAt, endAt, isActive: input.isActive },
      }),
      ...(input.productIds
        ? [
            prisma.dealItem.deleteMany({ where: { dealId: deal.id } }),
            prisma.dealItem.createMany({
              data: input.productIds.map((productId, i) => ({
                dealId: deal.id,
                productId,
                sortOrder: i,
              })),
            }),
          ]
        : []),
    ]);
    bustHomeCache();
    res.json({ success: true, data: { id: deal.id } });
  } catch (err) {
    next(err);
  }
});

adminContentRouter.delete('/deals/:id', async (req, res, next) => {
  try {
    await prisma.deal.delete({ where: { id: req.params.id } }).catch(() => {
      throw ApiError.notFound('Deal not found');
    });
    bustHomeCache();
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Newsletter subscribers (view; export happens client-side as CSV)
// ---------------------------------------------------------------------------

adminContentRouter.get('/newsletter', async (_req, res, next) => {
  try {
    const subscribers = await prisma.newsletterSubscriber.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const rows: NewsletterSubscriberRow[] = subscribers.map((s) => ({
      id: s.id,
      email: s.email,
      createdAt: s.createdAt.toISOString(),
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});
