import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  OPTION_KEY_RE,
  axesOf,
  axisLabel,
  compareOptionValues,
  optionValuesFromJson,
  productListQuerySchema,
  type AddonProduct,
  type CategoryRules,
  type ProductDetail,
  type ProductListItem,
  type ProductListResponse,
  type ProductVariantInfo,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import {
  listingStockFields,
  productListItemInclude,
  toProductListItem,
} from '../utils/productListing';
import { optionalAuth } from '../middleware/auth';
import { isSensitiveForTryOn } from '../services/tryon/sensitiveGarment';
import { isListingBelowTryOnAge } from '../services/tryon/ageGate';
import { searchFacets, searchProducts } from '../services/productSearch';
import { searchDroppableValues, type SearchDroppable } from '@clowe/shared';
import {
  categoryRulesFor,
  descendantIds,
  resolveCategory,
  returnWindowDaysFor,
} from '../services/categoryRules';

export const productsRouter = Router();

/** What every storefront query starts from. */
const LIVE: Prisma.ProductWhereInput = {
  status: 'APPROVED',
  isVisible: true,
  seller: { vacationMode: false },
};

/**
 * Option filters from the query string: the generic `opt[key]=a,b` form plus
 * the legacy `sizes` / `colors` params. Values within one axis are OR-ed,
 * axes are AND-ed.
 */
function optionFilters(query: {
  opt?: Record<string, string>;
  sizes?: string;
  colors?: string;
}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (key: string, csv: string | undefined) => {
    const values = (csv ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (values.length) out[key] = [...new Set([...(out[key] ?? []), ...values])];
  };
  add('size', query.sizes);
  add('color', query.colors);
  for (const [key, csv] of Object.entries(query.opt ?? {})) {
    if (OPTION_KEY_RE.test(key)) add(key, csv);
  }
  return out;
}

/** Facet order: the category's axes first, then colour, size, then alphabetical. */
function facetRank(key: string, rules: CategoryRules | null): number {
  const preferred = [...(rules?.variantAxes.map((a) => a.key) ?? []), 'color', 'size'];
  const i = preferred.indexOf(key);
  return i === -1 ? preferred.length : i;
}

// Storefront product listing: filters + search + facets + pagination.
// Only APPROVED products are ever visible here.
productsRouter.get('/', async (req, res, next) => {
  try {
    const query = productListQuerySchema.parse(req.query);

    // Resolve category slug → self + every descendant (any depth).
    let categoryIds: string[] | undefined;
    let scopeRules: CategoryRules | null = null;
    if (query.category) {
      const category = await prisma.category.findUnique({ where: { slug: query.category } });
      if (!category) throw ApiError.notFound('Category not found');
      categoryIds = await descendantIds(category.id);
      scopeRules = await categoryRulesFor(category.id);
    }

    const brands = query.brands?.split(',').filter(Boolean);
    const options = optionFilters(query);

    const optionAnd: Prisma.ProductVariantWhereInput[] = Object.entries(options).map(
      ([key, values]) => ({
        OR: values.map((value) => ({ optionValues: { path: [key], equals: value } })),
      }),
    );
    const variantFilter: Prisma.ProductVariantWhereInput = {
      ...(optionAnd.length ? { AND: optionAnd } : {}),
      ...(query.minPrice != null ? { pricePaise: { gte: query.minPrice * 100 } } : {}),
    };
    if (query.maxPrice != null) {
      variantFilter.pricePaise = {
        ...(variantFilter.pricePaise as object | undefined),
        lte: query.maxPrice * 100,
      };
    }

    const where: Prisma.ProductWhereInput = {
      ...LIVE,
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
      ...(brands?.length ? { brand: { in: brands } } : {}),
      ...(Object.keys(variantFilter).length ? { variants: { some: variantFilter } } : {}),
    };

    // A search request takes a different path: the words are parsed into
    // filters and the rows are ranked by relevance. Browsing without `q` is
    // untouched and still runs the query built above.
    if (query.q) {
      const search = await searchProducts({
        raw: query.q,
        drop: (query.drop ?? '')
          .split(',')
          .map((key) => key.trim())
          .filter((key): key is SearchDroppable =>
            (searchDroppableValues as readonly string[]).includes(key),
          ),
        baseWhere: where,
        sort: query.sort,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      });

      const found = await prisma.product.findMany({
        where: { id: { in: search.ids } },
        include: {
          category: { select: { name: true } },
          images: { orderBy: { sortOrder: 'asc' }, take: 1 },
          variants: {
            select: { id: true, size: true, color: true, pricePaise: true, mrpPaise: true, stock: true },
          },
        },
      });
      // findMany loses the ranking, so put the rows back in the ranked order.
      const byId = new Map(found.map((p) => [p.id, p]));
      const rankedItems = search.ids.flatMap((id) => {
        const product = byId.get(id);
        return product ? [toProductListItem(product)] : [];
      });

      const extraFacets = await searchFacets(where);
      const searchBody: ProductListResponse = {
        items: rankedItems,
        total: search.total,
        page: query.page,
        limit: query.limit,
        facets: {
          sizes: [],
          colors: [],
          options: [],
          priceRange: null,
          ...extraFacets,
        },
        search: search.meta,
      };
      res.json({ success: true, data: searchBody });
      return;
    }

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
      ...LIVE,
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
        }),
        // Facets: every option axis + value that exists in the category scope.
        prisma.productVariant.findMany({
          where: { product: facetScope },
          select: { optionValues: true },
          take: 5000,
        }),
        // Price bounds in scope — for the range slider.
        prisma.productVariant.aggregate({
          where: { product: facetScope },
          _min: { pricePaise: true },
          _max: { pricePaise: true },
        }),
        // Brand facet with counts.
        prisma.product.groupBy({ by: ['brand'], where: facetScope, _count: { _all: true } }),
        // Subcategory facet with counts.
        prisma.product.groupBy({ by: ['categoryId'], where: facetScope, _count: { _all: true } }),
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
        // size/color are display caches of optionValues — "" when the axis is absent.
        sizes: [...new Set(p.variants.map((v) => v.size).filter(Boolean))],
        colors: [...new Set(p.variants.map((v) => v.color).filter(Boolean))],
        // Denormalised rating cache — synced on every review write.
        ratingAvg: p.ratingCount > 0 ? p.ratingAvg : null,
        ratingCount: p.ratingCount,
        ...listingStockFields(p.variants),
      };
    });

    // Option facets: axis → distinct values across the scope.
    const valuesByKey = new Map<string, Set<string>>();
    for (const v of facetVariants) {
      for (const [key, value] of Object.entries(optionValuesFromJson(v.optionValues))) {
        const set = valuesByKey.get(key) ?? new Set<string>();
        set.add(value);
        valuesByKey.set(key, set);
      }
    }
    const optionFacets = [...valuesByKey.entries()]
      .sort(
        (a, b) =>
          facetRank(a[0], scopeRules) - facetRank(b[0], scopeRules) || a[0].localeCompare(b[0]),
      )
      .map(([key, set]) => ({
        key,
        label: scopeRules?.variantAxes.find((a) => a.key === key)?.label ?? axisLabel(key),
        values: [...set].sort(compareOptionValues),
      }));

    const body: ProductListResponse = {
      items,
      total,
      page: query.page,
      limit: query.limit,
      facets: {
        sizes: optionFacets.find((f) => f.key === 'size')?.values ?? [],
        colors: optionFacets.find((f) => f.key === 'color')?.values ?? [],
        options: optionFacets,
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
        ...LIVE,
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

// Products by id, in the order asked for. Powers the "Recently viewed" rail,
// whose ids live in the visitor's own browser, so it works logged out too.
// Declared before /:slug so "by-ids" isn't read as a product slug.
productsRouter.get('/by-ids', async (req, res, next) => {
  try {
    const ids = [
      ...new Set(
        String(req.query.ids ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ].slice(0, 24);
    if (ids.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }
    const products = await prisma.product.findMany({
      where: { ...LIVE, id: { in: ids } },
      include: productListItemInclude,
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    // Answer in the order asked for; ids that no longer resolve just drop out.
    const items: ProductListItem[] = ids.flatMap((id) => {
      const product = byId.get(id);
      return product ? [toProductListItem(product)] : [];
    });
    res.json({ success: true, data: items });
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
        category: { select: { name: true, slug: true } },
        seller: {
          select: {
            shopName: true,
            city: true,
            state: true,
            status: true,
            slug: true,
            vacationMode: true,
            returnWindowDays: true,
            tryOnCredits: true,
          },
        },
        images: { orderBy: { sortOrder: 'asc' } },
        variants: true,
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

    const resolved = await resolveCategory(product.categoryId);
    const variants: ProductVariantInfo[] = product.variants.map((v) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      optionValues: optionValuesFromJson(v.optionValues),
      label: v.label,
      sku: v.sku,
      pricePaise: v.pricePaise,
      mrpPaise: v.mrpPaise,
      stock: v.stock,
    }));
    const variantAxes = axesOf(variants, resolved.rules.variantAxes);
    // Order variants along the axes so size buttons read S, M, L rather than L, M, S.
    variants.sort((a, b) => {
      for (const axis of variantAxes) {
        const diff = compareOptionValues(a.optionValues[axis.key] ?? '', b.optionValues[axis.key] ?? '');
        if (diff !== 0) return diff;
      }
      return a.pricePaise - b.pricePaise;
    });

    const body: ProductDetail = {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      brand: product.brand,
      category: { name: product.category.name, slug: product.category.slug },
      rootCategorySlug: resolved.rootSlug || product.category.slug,
      variantAxes,
      // Mirrors the guards on POST /api/tryon so the "Try On Me" button is
      // only offered where a run would actually be accepted.
      tryOnEligible:
        resolved.rules.tryOnEligible &&
        product.tryOnEnabled &&
        !isSensitiveForTryOn(product.category.name, product.title) &&
        !isListingBelowTryOnAge(product.variants.map((v) => v.size)) &&
        product.seller.tryOnCredits > 0 &&
        (product.tryOnLimit == null || product.tryOnUsed < product.tryOnLimit),
      sizeGuide: resolved.rules.sizeGuide && variantAxes.some((a) => a.key === 'size'),
      returnWindowDays: await returnWindowDaysFor(product.categoryId, product.seller.returnWindowDays),
      sellerShopName: product.seller.shopName,
      seller: {
        shopName: product.seller.shopName,
        city: product.seller.city,
        state: product.seller.state,
        isVerified: product.seller.status === 'APPROVED',
        slug: product.seller.slug,
      },
      images: product.images.map((i) => ({ url: i.url, altText: i.altText })),
      variants,
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
