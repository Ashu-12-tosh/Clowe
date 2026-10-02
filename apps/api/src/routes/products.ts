import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  COMMON_FACETS,
  FACET_KEY_RE,
  axesOf,
  colorFamilyOf,
  compareOptionValues,
  normaliseAttributes,
  optionValuesFromJson,
  productListQuerySchema,
  type AddonProduct,
  type FacetRail,
  type ProductDetail,
  type ProductListItem,
  type ProductListQuery,
  type ProductListResponse,
  type ProductVariantInfo,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { productListItemInclude, toProductListItem } from '../utils/productListing';
import { optionalAuth } from '../middleware/auth';
import { isSensitiveForTryOn } from '../services/tryon/sensitiveGarment';
import { isListingBelowTryOnAge } from '../services/tryon/ageGate';
import { searchFacets, searchProducts } from '../services/productSearch';
import { logSearch } from '../services/searchAnalytics';
import { searchDroppableValues, type SearchDroppable } from '@clowe/shared';
import {
  categoryRows,
  descendantIds,
  resolveCategory,
  returnWindowDaysFor,
} from '../services/categoryRules';
import {
  ENGINE_SELECT,
  runFacetEngine,
  toEngineProduct,
  type EngineProduct,
  type RailFilters,
} from '../services/facetEngine';

/** Rail entries that are not a category facet. */
const COMMON_RAIL_KEYS = new Set<string>(COMMON_FACETS);

export const productsRouter = Router();

/** What every storefront query starts from. */
const LIVE: Prisma.ProductWhereInput = {
  status: 'APPROVED',
  isVisible: true,
  seller: { vacationMode: false },
};

/**
 * The rail's filters from the query string. `f[key]` is the form the rail
 * writes; `opt[key]=a,b`, `sizes` and `colors` are older links, still honoured.
 * Colours filter by family, so an old `colors=Navy` link finds every blue.
 */
function railFiltersFrom(query: ProductListQuery): RailFilters {
  const facets = new Map<string, string[]>();
  const add = (key: string, values: string[]) => {
    if (!FACET_KEY_RE.test(key)) return;
    const list = facets.get(key) ?? [];
    for (const raw of values) {
      const value = raw.trim();
      if (!value) continue;
      const v = key === 'color' ? (colorFamilyOf(value) ?? value) : value;
      if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
    }
    if (list.length) facets.set(key, list);
  };
  for (const [key, raw] of Object.entries(query.f ?? {})) add(key, Array.isArray(raw) ? raw : [raw]);
  for (const [key, csv] of Object.entries(query.opt ?? {})) add(key, csv.split(','));
  if (query.sizes) add('size', query.sizes.split(','));
  if (query.colors) add('color', query.colors.split(','));
  return {
    facets,
    brands: (query.brands ?? '').split(',').map((b) => b.trim()).filter(Boolean),
    minRating: query.rating ?? null,
    minDiscount: query.discount ?? null,
    inStock: query.inStock !== undefined,
    minPaise: query.minPrice != null ? query.minPrice * 100 : null,
    maxPaise: query.maxPrice != null ? query.maxPrice * 100 : null,
  };
}

// Storefront product listing: filters + search + facets + pagination.
// Only live products are ever visible here.
//
// The scope is the category picked (or everything), narrowed by the words of
// a search when there are any; the filter rail then works over that scope in
// memory (services/facetEngine.ts), which gives both the matching products and
// every count.
productsRouter.get('/', async (req, res, next) => {
  try {
    const query = productListQuerySchema.parse(req.query);

    // Resolve category slug → self + every descendant (any depth).
    let categoryIds: string[] | undefined;
    let explicitCategoryId: string | null = null;
    if (query.category) {
      const category = await prisma.category.findUnique({ where: { slug: query.category } });
      if (!category) throw ApiError.notFound('Category not found');
      explicitCategoryId = category.id;
      categoryIds = await descendantIds(category.id);
    }
    const scopeWhere: Prisma.ProductWhereInput = {
      ...LIVE,
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
    };
    const filters = railFiltersFrom(query);

    let scope: EngineProduct[];
    let search: Awaited<ReturnType<typeof searchProducts>> | null = null;
    let preferredCategoryId = explicitCategoryId;
    let basisKind: FacetRail['basis']['kind'] = explicitCategoryId ? 'category' : 'mixed';

    if (query.q) {
      // The words are parsed into filters and the matches ranked by relevance;
      // the rail's filters apply to what that finds, keeping its order.
      search = await searchProducts({
        raw: query.q,
        drop: (query.drop ?? '')
          .split(',')
          .map((key) => key.trim())
          .filter((key): key is SearchDroppable =>
            (searchDroppableValues as readonly string[]).includes(key),
          ),
        baseWhere: scopeWhere,
        sort: query.sort,
        // The schema fills in a default, so the only way to tell a picked sort
        // from that default is whether the request carried one at all.
        sortChosen: req.query.sort !== undefined,
        skip: 0,
        take: 0,
      });
      const rows = await prisma.product.findMany({ where: { id: { in: search.allIds } }, select: ENGINE_SELECT });
      const byId = new Map(rows.map((r) => [r.id, toEngineProduct(r)]));
      scope = search.allIds.flatMap((id) => byId.get(id) ?? []);
      // A guessed category chooses the facets. It never filters: the scope
      // above is everything the words found, in every category.
      const inferredSlug = search.meta.parsed.filters.inferredCategorySlug;
      if (!preferredCategoryId && inferredSlug) {
        const inferred = await prisma.category.findUnique({ where: { slug: inferredSlug }, select: { id: true } });
        if (inferred) {
          preferredCategoryId = inferred.id;
          basisKind = 'inferred';
        }
      }
    } else {
      scope = (await prisma.product.findMany({ where: scopeWhere, select: ENGINE_SELECT })).map(toEngineProduct);
    }

    const engine = await runFacetEngine({
      products: scope,
      filters,
      preferredCategoryId,
      basisKind,
      // A search keeps its ranking; browsing sorts.
      sort: search ? null : query.sort,
    });

    const skip = (query.page - 1) * query.limit;
    const pageIds = engine.ids.slice(skip, skip + query.limit);
    const found = await prisma.product.findMany({ where: { id: { in: pageIds } }, include: productListItemInclude });
    const byId = new Map(found.map((p) => [p.id, p]));
    const items: ProductListItem[] = pageIds.flatMap((id) => {
      const product = byId.get(id);
      return product ? [toProductListItem(product)] : [];
    });

    const categoryNames = new Map([...(await categoryRows()).values()].map((c) => [c.id, c]));
    const option = (key: string) => engine.rail.facets.find((f) => f.key === key);
    const body: ProductListResponse = {
      items,
      total: engine.ids.length,
      page: query.page,
      limit: query.limit,
      // The older shape, for clients that have not moved to `rail`.
      facets: {
        sizes: option('size')?.values.map((v) => v.value) ?? [],
        colors: option('color')?.values.map((v) => v.value) ?? [],
        options: engine.rail.facets
          .filter((f) => !COMMON_RAIL_KEYS.has(f.key))
          .map((f) => ({ key: f.key, label: f.label, values: f.values.map((v) => v.value) })),
        brands: (option('brand')?.values ?? []).map((v) => ({ name: v.value, count: v.count })),
        categories: [...engine.categoryCounts.entries()]
          .flatMap(([id, count]) => {
            const cat = categoryNames.get(id);
            return cat ? [{ name: cat.name, slug: cat.slug, count }] : [];
          })
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        priceRange: engine.rail.price
          ? { minPaise: engine.rail.price.minPaise, maxPaise: engine.rail.price.maxPaise }
          : null,
        ...(search ? await searchFacets(scopeWhere).then(({ ratings, priceBuckets }) => ({ ratings, priceBuckets })) : {}),
      },
      rail: engine.rail,
      ...(search
        ? {
            search: {
              ...search.meta,
              outsideInferredCategory: pageIds.filter((id) => search!.outsideIds.has(id)).length,
            },
          }
        : {}),
    };
    res.json({ success: true, data: body });
    // After the response. Not awaited, cannot throw — a lost data point must
    // never cost a shopper a search.
    if (search) logSearch(query.q!, search.meta, engine.ids.length);
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
        // The product's own gallery, untouched: variant pictures live in their
        // own table precisely so this keeps meaning what it always meant.
        images: { orderBy: { sortOrder: 'asc' } },
        variants: { include: { images: { orderBy: { sortOrder: 'asc' } } } },
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
      images: v.images.map((i) => ({ url: i.url, altText: i.altText })),
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
      // Rows stored before keys existed still read back canonical.
      attributes: normaliseAttributes(product.attributes, resolved.rules.attributeSchema),
      videoUrl: product.videoUrl,
      createdAt: product.createdAt.toISOString(),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
