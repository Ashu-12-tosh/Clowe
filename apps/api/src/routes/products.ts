import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  productListQuerySchema,
  type AddonProduct,
  type ProductDetail,
  type ProductListItem,
  type ProductListResponse,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { listingStockFields } from '../utils/productListing';
import { optionalAuth } from '../middleware/auth';

export const productsRouter = Router();

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
    const brands = query.brands?.split(',').filter(Boolean);

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
      status: 'APPROVED', isVisible: true, seller: { vacationMode: false },
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
      ...(brands?.length ? { brand: { in: brands } } : {}),
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

    const ORDER_BY: Record<typeof query.sort, Prisma.ProductOrderByWithRelationInput> = {
      popularity: { soldCount: 'desc' },
      newest: { createdAt: 'desc' },
      price_asc: { basePricePaise: 'asc' },
      price_desc: { basePricePaise: 'desc' },
      rating: { ratingAvg: 'desc' },
    };
    const orderBy = ORDER_BY[query.sort];

    // Facet scope = the category (and other filters), but never a facet's own
    // filter — otherwise picking one brand would hide every other brand.
    const facetScope: Prisma.ProductWhereInput = {
      status: 'APPROVED', isVisible: true, seller: { vacationMode: false },
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
    };

    const [total, products, facetVariants, priceAgg, brandGroups, categoryGroups, scopeCategories] =
      await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          category: { select: { name: true } },
          images: { orderBy: { sortOrder: 'asc' }, take: 1 },
          variants: {
            select: { id: true, size: true, color: true, pricePaise: true, mrpPaise: true, stock: true },
          },
        },
      }),
      // Facets: what sizes/colors exist in the current category scope.
      prisma.productVariant.findMany({
        where: {
          product: { status: 'APPROVED', isVisible: true, seller: { vacationMode: false }, ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) },
        },
        select: { size: true, color: true },
        distinct: ['size', 'color'],
      }),
      // Price bounds in scope — for the range slider.
      prisma.productVariant.aggregate({
        where: {
          product: { status: 'APPROVED', isVisible: true, seller: { vacationMode: false }, ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) },
        },
        _min: { pricePaise: true },
        _max: { pricePaise: true },
      }),
      // Brand facet with counts.
      prisma.product.groupBy({
        by: ['brand'],
        where: facetScope,
        _count: { _all: true },
      }),
      // Subcategory facet with counts.
      prisma.product.groupBy({
        by: ['categoryId'],
        where: facetScope,
        _count: { _all: true },
      }),
      categoryIds
        ? prisma.category.findMany({
            where: { id: { in: categoryIds } },
            select: { id: true, name: true, slug: true },
          })
        : prisma.category.findMany({ select: { id: true, name: true, slug: true } }),
    ]);

    const categoryById = new Map(scopeCategories.map((c) => [c.id, c]));

    const items: ProductListItem[] = products.map((p) => {
      const minVariant = p.variants.reduce(
        (min, v) => (v.pricePaise < min.pricePaise ? v : min),
        p.variants[0] ?? {
          id: '',
          pricePaise: p.basePricePaise,
          mrpPaise: null,
          size: '',
          color: '',
          stock: 0,
        },
      );
      return {
        id: p.id,
        slug: p.slug,
        title: p.title,
        brand: p.brand,
        categoryName: p.category.name,
        pricePaise: minVariant.pricePaise,
        mrpPaise: p.mrpPaise ?? minVariant.mrpPaise,
        imageUrl: p.images[0]?.url ?? null,
        sizes: [...new Set(p.variants.map((v) => v.size).filter(Boolean))],
        colors: [...new Set(p.variants.map((v) => v.color).filter(Boolean))],
        // Denormalised rating cache — synced on every review write.
        ratingAvg: p.ratingCount > 0 ? p.ratingAvg : null,
        ratingCount: p.ratingCount,
        ...listingStockFields(p.variants),
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
        brands: brandGroups
          .filter((g): g is typeof g & { brand: string } => Boolean(g.brand))
          .map((g) => ({ name: g.brand, count: g._count._all }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        categories: categoryGroups
          .flatMap((g) => {
            const cat = categoryById.get(g.categoryId);
            return cat ? [{ name: cat.name, slug: cat.slug, count: g._count._all }] : [];
          })
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
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

// Cheap add-ons for the checkout's "Frequently bought together" row. Each
// carries an in-stock variant id so one tap adds it to the cart.
// Declared before /:slug so "addons" isn't read as a product slug.
productsRouter.get('/addons', async (req, res, next) => {
  try {
    const exclude = String(req.query.exclude ?? '')
      .split(',')
      .filter(Boolean);
    const limit = Math.min(Number(req.query.limit) || 4, 12);

    const products = await prisma.product.findMany({
      where: {
        status: 'APPROVED', isVisible: true, seller: { vacationMode: false },
        ...(exclude.length ? { id: { notIn: exclude } } : {}),
        variants: { some: { stock: { gt: 0 }, pricePaise: { lte: 200000 } } },
      },
      orderBy: [{ ratingCount: 'desc' }, { createdAt: 'desc' }],
      take: limit * 3, // over-fetch, then keep the cheapest picks
      include: {
        images: { orderBy: { sortOrder: 'asc' }, take: 1 },
        variants: {
          where: { stock: { gt: 0 } },
          orderBy: { pricePaise: 'asc' },
          take: 1,
        },
      },
    });

    const addons: AddonProduct[] = products
      .filter((p) => p.variants.length > 0)
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        brand: p.brand,
        imageUrl: p.images[0]?.url ?? null,
        pricePaise: p.variants[0].pricePaise,
        mrpPaise: p.variants[0].mrpPaise,
        variantId: p.variants[0].id,
      }))
      .sort((a, b) => a.pricePaise - b.pricePaise)
      .slice(0, limit);

    res.json({ success: true, data: addons });
  } catch (err) {
    next(err);
  }
});

// Product detail by slug. optionalAuth so a logged-in view lands in the
// shopper's "Recently viewed" list as well as the trending signal.
productsRouter.get('/:slug', optionalAuth, async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { slug: req.params.slug },
      include: {
        category: { select: { name: true, slug: true, parent: { select: { slug: true } } } },
        seller: {
          select: {
            shopName: true,
            city: true,
            state: true,
            status: true,
            slug: true,
            vacationMode: true,
          },
        },
        images: { orderBy: { sortOrder: 'asc' } },
        variants: { orderBy: [{ color: 'asc' }, { size: 'asc' }] },
      },
    });
    // Hidden listings 404 like an unapproved one — the seller's own toggle.
    // A shop on vacation is treated the same way.
    if (
      !product ||
      product.status !== 'APPROVED' ||
      !product.isVisible ||
      product.seller.vacationMode
    ) {
      throw ApiError.notFound('Product not found');
    }

    // Trending signal: record the view without delaying the response.
    void prisma
      .$transaction([
        prisma.productView.create({
          data: { productId: product.id, userId: req.auth?.userId ?? null },
        }),
        prisma.product.update({
          where: { id: product.id },
          data: { viewCount: { increment: 1 } },
        }),
      ])
      .catch(() => {});

    const body: ProductDetail = {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      brand: product.brand,
      category: { name: product.category.name, slug: product.category.slug },
      rootCategorySlug: product.category.parent?.slug ?? product.category.slug,
      sellerShopName: product.seller.shopName,
      seller: {
        shopName: product.seller.shopName,
        city: product.seller.city,
        state: product.seller.state,
        isVerified: product.seller.status === 'APPROVED',
        slug: product.seller.slug,
      },
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
      ratingAvg: product.ratingCount > 0 ? product.ratingAvg : null,
      ratingCount: product.ratingCount,
      soldCount: product.soldCount,
      isBestSeller: product.isBestSeller,
      isNew: product.isNew,
      // Free-form JSON column — keep only the strings the UI can render.
      highlights: Array.isArray(product.highlights)
        ? product.highlights.filter((h): h is string => typeof h === 'string')
        : [],
      shortDescription: product.shortDescription,
      attributes: Array.isArray(product.attributes)
        ? (product.attributes as { name: string; value: string }[]).filter(
            (a) => a && typeof a.name === 'string' && typeof a.value === 'string',
          )
        : [],
      videoUrl: product.videoUrl,
      createdAt: product.createdAt.toISOString(),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
