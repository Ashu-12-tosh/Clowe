import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  productListQuerySchema,
  type ProductDetail,
  type ProductListItem,
  type ProductListResponse,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';

export const productsRouter = Router();

/** Average ratings for a set of product ids, in one query. */
async function ratingsFor(productIds: string[]) {
  const rows = await prisma.review.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds } },
    _avg: { rating: true },
    _count: { rating: true },
  });
  return new Map(rows.map((r) => [r.productId, r]));
}

// Storefront product listing: filters + search + facets + pagination.
// Only APPROVED products are ever visible here.
productsRouter.get('/', async (req, res, next) => {
  try {
    const query = productListQuerySchema.parse(req.query);

    // Resolve category slug → self + child category ids.
    let categoryIds: string[] | undefined;
    if (query.category) {
      const category = await prisma.category.findUnique({
        where: { slug: query.category },
        include: { children: { select: { id: true } } },
      });
      if (!category) throw ApiError.notFound('Category not found');
      categoryIds = [category.id, ...category.children.map((c) => c.id)];
    }

    const sizes = query.sizes?.split(',').filter(Boolean);
    const colors = query.colors?.split(',').filter(Boolean);

    const variantFilter: Prisma.ProductVariantWhereInput = {
      ...(sizes?.length ? { size: { in: sizes } } : {}),
      ...(colors?.length ? { color: { in: colors, mode: 'insensitive' } } : {}),
      ...(query.minPrice != null ? { pricePaise: { gte: query.minPrice * 100 } } : {}),
    };
    if (query.maxPrice != null) {
      variantFilter.pricePaise = {
        ...(variantFilter.pricePaise as object | undefined),
        lte: query.maxPrice * 100,
      };
    }

    const where: Prisma.ProductWhereInput = {
      status: 'APPROVED',
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
      ...(Object.keys(variantFilter).length ? { variants: { some: variantFilter } } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { brand: { contains: query.q, mode: 'insensitive' } },
              { description: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.ProductOrderByWithRelationInput =
      query.sort === 'price_asc'
        ? { basePricePaise: 'asc' }
        : query.sort === 'price_desc'
          ? { basePricePaise: 'desc' }
          : { createdAt: 'desc' };

    const [total, products, facetVariants, priceAgg] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          category: { select: { name: true } },
          images: { orderBy: { sortOrder: 'asc' }, take: 1 },
          variants: { select: { size: true, color: true, pricePaise: true, mrpPaise: true } },
        },
      }),
      // Facets: what sizes/colors exist in the current category scope.
      prisma.productVariant.findMany({
        where: {
          product: { status: 'APPROVED', ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) },
        },
        select: { size: true, color: true },
        distinct: ['size', 'color'],
      }),
      // Price bounds in scope — for the range slider.
      prisma.productVariant.aggregate({
        where: {
          product: { status: 'APPROVED', ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) },
        },
        _min: { pricePaise: true },
        _max: { pricePaise: true },
      }),
    ]);

    const ratings = await ratingsFor(products.map((p) => p.id));

    const items: ProductListItem[] = products.map((p) => {
      const minVariant = p.variants.reduce(
        (min, v) => (v.pricePaise < min.pricePaise ? v : min),
        p.variants[0] ?? { pricePaise: p.basePricePaise, mrpPaise: null, size: '', color: '' },
      );
      const rating = ratings.get(p.id);
      return {
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
      };
    });

    const body: ProductListResponse = {
      items,
      total,
      page: query.page,
      limit: query.limit,
      facets: {
        sizes: [...new Set(facetVariants.map((v) => v.size))].sort(),
        colors: [...new Set(facetVariants.map((v) => v.color))].sort(),
        priceRange:
          priceAgg._min.pricePaise != null && priceAgg._max.pricePaise != null
            ? { minPaise: priceAgg._min.pricePaise, maxPaise: priceAgg._max.pricePaise }
            : null,
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// Product detail by slug.
productsRouter.get('/:slug', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { slug: req.params.slug },
      include: {
        category: { select: { name: true, slug: true } },
        seller: { select: { shopName: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        variants: { orderBy: [{ color: 'asc' }, { size: 'asc' }] },
      },
    });
    if (!product || product.status !== 'APPROVED') {
      throw ApiError.notFound('Product not found');
    }

    const rating = (await ratingsFor([product.id])).get(product.id);

    const body: ProductDetail = {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      brand: product.brand,
      category: product.category,
      sellerShopName: product.seller.shopName,
      images: product.images.map((i) => ({ url: i.url, altText: i.altText })),
      variants: product.variants.map((v) => ({
        id: v.id,
        size: v.size,
        color: v.color,
        sku: v.sku,
        pricePaise: v.pricePaise,
        mrpPaise: v.mrpPaise,
        stock: v.stock,
      })),
      ratingAvg: rating?._avg.rating ?? null,
      ratingCount: rating?._count.rating ?? 0,
      createdAt: product.createdAt.toISOString(),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
