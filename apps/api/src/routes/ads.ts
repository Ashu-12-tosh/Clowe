import { Router } from 'express';
import { z } from 'zod';
import { AD_PLACEMENTS, type ActiveAd } from '@clowe/shared';
import { prisma } from '../db';
import { listingStockFields } from '../utils/productListing';

export const adsRouter = Router();

/**
 * Lazily expire ads whose run has ended (and tell the seller).
 * Called from the public serve path so no cron is needed.
 */
export async function expireDueAds(): Promise<void> {
  const due = await prisma.ad.findMany({
    where: { status: 'ACTIVE', endAt: { lt: new Date() } },
    include: { seller: { select: { userId: true } }, product: { select: { title: true } } },
  });
  for (const ad of due) {
    await prisma.$transaction([
      prisma.ad.update({ where: { id: ad.id }, data: { status: 'EXPIRED' } }),
      prisma.notification.create({
        data: {
          userId: ad.seller.userId,
          type: 'AD_EXPIRED',
          title: 'Your ad has ended',
          body: `Your ${ad.durationDays}-day ad for "${ad.product.title}" has completed its run (${ad.views} views, ${ad.clicks} clicks). Create a new ad anytime from Advertise.`,
        },
      }),
    ]);
  }
}

// Active ads for a storefront slot. ?placement=HOME_BANNER | CATEGORY_SPONSORED(&category=slug)
adsRouter.get('/active', async (req, res, next) => {
  try {
    const { placement, category } = z
      .object({ placement: z.enum(AD_PLACEMENTS), category: z.string().optional() })
      .parse(req.query);

    await expireDueAds();

    const ads = await prisma.ad.findMany({
      where: { status: 'ACTIVE', placement, product: { status: 'APPROVED', isVisible: true, seller: { vacationMode: false } } },
      orderBy: { startAt: 'desc' },
      take: 10,
      include: {
        product: {
          include: {
            images: { orderBy: { sortOrder: 'asc' }, take: 1 },
            variants: true,
            category: { include: { parent: { select: { slug: true } } } },
          },
        },
      },
    });

    // Category slot: match the product's category or its parent.
    const matched =
      placement === 'CATEGORY_SPONSORED' && category
        ? ads.filter(
            (ad) =>
              ad.product.category.slug === category || ad.product.category.parent?.slug === category,
          )
        : ads;
    const served = matched.slice(0, 5);

    if (served.length > 0) {
      await prisma.ad.updateMany({
        where: { id: { in: served.map((a) => a.id) } },
        data: { views: { increment: 1 } },
      });
    }

    // Ratings so sponsored cards look exactly like organic listing cards.
    const ratings = await prisma.review.groupBy({
      by: ['productId'],
      where: { productId: { in: served.map((a) => a.productId) } },
      _avg: { rating: true },
      _count: { rating: true },
    });
    const ratingByProduct = new Map(ratings.map((r) => [r.productId, r]));

    const body: ActiveAd[] = served.map((ad) => {
      const p = ad.product;
      const minVariant = p.variants.reduce(
        (min, v) => (v.pricePaise < min.pricePaise ? v : min),
        p.variants[0] ?? { pricePaise: p.basePricePaise, mrpPaise: null, size: '', color: '' },
      );
      const rating = ratingByProduct.get(p.id);
      return {
        id: ad.id,
        placement: ad.placement,
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
          ratingAvg: rating?._avg.rating ?? null,
          ratingCount: rating?._count.rating ?? 0,
          ...listingStockFields(p.variants),
        },
      };
    });
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// Click beacon — fire-and-forget from the storefront.
adsRouter.post('/:id/click', async (req, res, next) => {
  try {
    await prisma.ad.updateMany({
      where: { id: req.params.id, status: 'ACTIVE' },
      data: { clicks: { increment: 1 } },
    });
    res.json({ success: true, data: { ok: true } });
  } catch (err) {
    next(err);
  }
});
