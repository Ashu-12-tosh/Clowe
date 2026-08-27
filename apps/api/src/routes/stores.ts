import { Router } from 'express';
import { z } from 'zod';
import { WEEKDAYS, type PublicStore, type StoreHighlight, type Weekday, type WorkingHours } from '@clowe/shared';
import { prisma } from '../db';
import { getSettings } from '../services/settingsService';
import { ApiError } from '../utils/ApiError';

export const storesRouter = Router();

const DEFAULT_HOURS: Record<Weekday, WorkingHours> = Object.fromEntries(
  WEEKDAYS.map((d) => [d, { open: '09:00', close: '21:00', closed: false }]),
) as Record<Weekday, WorkingHours>;

/** Public store page: the shop's own storefront at /store/<slug>. */
storesRouter.get('/:slug', async (req, res, next) => {
  try {
    const seller = await prisma.sellerProfile.findUnique({
      where: { slug: req.params.slug },
      include: { user: { select: { createdAt: true } } },
    });
    // Only approved shops have a public page; suspended ones 404.
    if (!seller || seller.status !== 'APPROVED') throw ApiError.notFound('Store not found');

    const [category, productCount, reviews] = await Promise.all([
      seller.primaryCategoryId
        ? prisma.category.findUnique({
            where: { id: seller.primaryCategoryId },
            select: { name: true },
          })
        : Promise.resolve(null),
      prisma.product.count({
        where: { sellerId: seller.id, status: 'APPROVED', isVisible: true },
      }),
      prisma.review.aggregate({
        where: { product: { sellerId: seller.id } },
        _avg: { rating: true },
        _count: { _all: true },
      }),
    ]);

    const body: PublicStore = {
      slug: seller.slug!,
      shopName: seller.shopName,
      tagline: seller.tagline,
      description: seller.description,
      logoUrl: seller.logoUrl,
      bannerUrl: seller.bannerUrl,
      isVerified: seller.kycStatus === 'VERIFIED',
      city: seller.city,
      state: seller.state,
      primaryCategoryName: category?.name ?? null,
      highlights: Array.isArray(seller.highlights) ? (seller.highlights as unknown as StoreHighlight[]) : [],
      socialLinks: {
        website: '',
        instagram: '',
        facebook: '',
        youtube: '',
        ...((seller.socialLinks as Record<string, string> | null) ?? {}),
      },
      workingHours: {
        ...DEFAULT_HOURS,
        ...((seller.workingHours as Partial<Record<Weekday, WorkingHours>> | null) ?? {}),
      },
      vacationMessage: seller.vacationMode
        ? (seller.vacationMessage ??
          'This shop is on a short break — orders resume when it reopens.')
        : null,
      ratingAvg:
        reviews._count._all > 0 ? Math.round((reviews._avg.rating ?? 0) * 10) / 10 : null,
      ratingCount: reviews._count._all,
      productCount,
      memberSince: seller.approvedAt?.toISOString() ?? seller.createdAt.toISOString(),
      returnWindowDays: seller.returnWindowDays ?? (await getSettings()).returnWindowDays,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

/** Products on sale in this shop. */
storesRouter.get('/:slug/products', async (req, res, next) => {
  try {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(4).max(48).default(12),
      })
      .parse(req.query);

    const seller = await prisma.sellerProfile.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, status: true, vacationMode: true },
    });
    if (!seller || seller.status !== 'APPROVED') throw ApiError.notFound('Store not found');

    const where = { sellerId: seller.id, status: 'APPROVED' as const, isVisible: true };
    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: [{ soldCount: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          images: { orderBy: { sortOrder: 'asc' }, take: 1 },
          variants: { select: { pricePaise: true, mrpPaise: true } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        // Vacation mode leaves the page up but stops the buying.
        acceptingOrders: !seller.vacationMode,
        items: products.map((p) => {
          const cheapest = p.variants.reduce<{ pricePaise: number; mrpPaise: number | null } | null>(
            (min, v) => (!min || v.pricePaise < min.pricePaise ? v : min),
            null,
          );
          return {
            id: p.id,
            title: p.title,
            slug: p.slug,
            brand: p.brand,
            imageUrl: p.images[0]?.url ?? null,
            pricePaise: cheapest?.pricePaise ?? p.basePricePaise,
            mrpPaise: cheapest?.mrpPaise ?? null,
            ratingAvg: p.ratingCount > 0 ? p.ratingAvg : null,
            ratingCount: p.ratingCount,
          };
        }),
      },
    });
  } catch (err) {
    next(err);
  }
});
