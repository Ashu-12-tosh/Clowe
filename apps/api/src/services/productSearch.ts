import { Prisma } from '@prisma/client';
import {
  SEARCH_SYNONYMS,
  parseSearchQuery,
  type ProductSort,
  type ParsedSearchQuery,
  type SearchCatalog,
  type SearchMeta,
  type SearchDroppable,
  type SearchRelaxable,
  type SearchRelaxation,
} from '@clowe/shared';
import { prisma } from '../db';

/**
 * What the storefront treats as buyable: approved, switched on by its seller,
 * and the seller not away. The suggest endpoint and the phrase generator both
 * filter on this, so neither can offer something the listing would not show.
 * Must match LIVE in routes/products.ts.
 */
export const LIVE_PRODUCT_WHERE = {
  status: 'APPROVED' as const,
  isVisible: true,
  seller: { vacationMode: false },
} satisfies Prisma.ProductWhereInput;

/**
 * Keyword search over the storefront catalog.
 *
 * The shape of a request is: parse the words into structured filters, apply
 * the filters, rank what is left by full-text relevance, and if the text found
 * nothing, try again fuzzily. If the filters themselves were too tight, loosen
 * them one at a time and say so rather than returning an empty page.
 *
 * Two rules run through all of it:
 *
 *   A guess may rank, never filter. The parser infers a category from words
 *   like "phone"; this catalog files smartphones under two different parents,
 *   so filtering on that guess would hide more than half of them. Only a
 *   category the shopper picked themselves narrows the result set.
 *
 *   Never quietly substitute. If a filter was dropped or a result came from
 *   outside the guessed category, it is reported back so the UI can say so.
 */

// ---------------------------------------------------------------------------
// Tuning — every number here was measured against the live catalog.
// ---------------------------------------------------------------------------

/**
 * Trigram cutoff for the typo fallback, measured over the 245-product catalog:
 *
 *   real typos of catalog words   0.500 - 0.750   (headfones 0.50, novatek 0.75)
 *   words with nothing to match   0.091 - 0.400   (xylophone 0.40, smasung 0.375)
 *
 * 0.45 sits in the gap, above every false positive and below every true one.
 * Re-measure if the catalog grows a lot: the gap is a property of the data,
 * not of the algorithm.
 */
const TRIGRAM_THRESHOLD = 0.45;

/**
 * Prior weight for the Bayesian rating, in reviews.
 *
 * Ratings are stored as a cached (avg, count) pair, and counts here span 3 to
 * ~14,000 with a median around 5,800. A plain average sort floats a 4.7 from
 * three reviews above a 4.9 from ten thousand. Blending each product with the
 * catalog mean fixes that:
 *
 *   weighted = (count·avg + PRIOR_REVIEWS·mean) / (count + PRIOR_REVIEWS)
 *
 * At 50, a product with 3 reviews is pulled almost entirely to the mean, one
 * with 80 is pulled part way, and anything in the thousands barely moves —
 * which is the intended behaviour in all three cases.
 */
const PRIOR_REVIEWS = 50;

/** Facet price buckets, in paise. */
const PRICE_BUCKETS: { label: string; minPaise: number | null; maxPaise: number | null }[] = [
  { label: 'Under ₹500', minPaise: null, maxPaise: 50_000 },
  { label: '₹500 - ₹2,000', minPaise: 50_000, maxPaise: 200_000 },
  { label: '₹2,000 - ₹10,000', minPaise: 200_000, maxPaise: 1_000_000 },
  { label: '₹10,000 - ₹30,000', minPaise: 1_000_000, maxPaise: 3_000_000 },
  { label: 'Above ₹30,000', minPaise: 3_000_000, maxPaise: null },
];

// ---------------------------------------------------------------------------
// Catalog cache
// ---------------------------------------------------------------------------

interface CachedCatalog extends SearchCatalog {
  /** Mean rating across rated products — the prior the Bayesian sort blends to. */
  meanRating: number;
  /**
   * Categories with their parent's name, for suggestions.
   *
   * Two categories can share a name under different parents — this catalog has
   * two called "Smartphones" — so the dropdown needs the parent to tell them
   * apart. The parser does not, which is why SearchCatalog stays lean.
   */
  categoryPaths: { slug: string; name: string; parentName: string | null }[];
  expires: number;
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalogCache: CachedCatalog | null = null;

/**
 * Brands and categories for the parser to match against.
 *
 * Around 36 brands and 67 categories, so this is a few kilobytes held for five
 * minutes rather than three queries on every keystroke.
 */
export async function searchCatalog(): Promise<CachedCatalog> {
  if (catalogCache && catalogCache.expires > Date.now()) return catalogCache;

  const [brands, categories, ratingAgg] = await Promise.all([
    prisma.brand.findMany({ select: { name: true } }),
    prisma.category.findMany({
      where: { isActive: true },
      select: { slug: true, name: true, parent: { select: { name: true } } },
    }),
    prisma.product.aggregate({
      _avg: { ratingAvg: true },
      where: { status: 'APPROVED', isVisible: true, ratingCount: { gt: 0 } },
    }),
  ]);

  catalogCache = {
    brands: brands.map((b) => b.name),
    categories: categories.map((c) => ({ slug: c.slug, name: c.name })),
    categoryPaths: categories.map((c) => ({
      slug: c.slug,
      name: c.name,
      parentName: c.parent?.name ?? null,
    })),
    // Falls back to the midpoint of the 1-5 scale on an empty catalog, so the
    // blend stays defined before anything has been reviewed.
    meanRating: ratingAgg._avg.ratingAvg ?? 3,
    expires: Date.now() + CATALOG_TTL_MS,
  };
  return catalogCache;
}

/** Drop the cache after an admin edits brands or categories. */
export function invalidateSearchCatalog(): void {
  catalogCache = null;
}

// ---------------------------------------------------------------------------
// Keyword expansion
// ---------------------------------------------------------------------------

/**
 * Every word a keyword could reasonably be written as.
 *
 * Expansion widens, never narrows: searching "phone" must still find a product
 * titled "Phone" as well as one titled "Smartphone". Replacing the shopper's
 * word with one canonical form would trade one empty result set for another
 * the first time a seller words a title differently.
 *
 * Postgres tokenises "headphone" to 'headphon' and "phone" to 'phone', so
 * unlike a substring match this cannot drag headphones into a phone search.
 */
export function expandKeyword(word: string): string[] {
  const lower = word.toLowerCase();
  const out = new Set<string>([lower]);
  for (const entry of SEARCH_SYNONYMS) {
    const family = [entry.canonical, ...entry.aliases].map((w) => w.toLowerCase());
    if (family.includes(lower)) for (const w of family) out.add(w);
  }
  return [...out];
}

/** Only word characters survive: tsquery input must never carry operators. */
function sanitiseTerm(term: string): string {
  return term.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * A tsquery string for the cleaned keywords.
 *
 * Each word becomes an OR-group of its synonyms, and the groups are ANDed, so
 * "wireless phone" needs something phone-ish AND something wireless. The word
 * the shopper actually typed is repeated so ts_rank scores it above a synonym
 * match without needing a second query.
 */
export function buildTsQuery(keywords: string): string {
  const words = sanitiseTerm(keywords).split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const groups = words.map((word) => {
    const forms = expandKeyword(word)
      .map(sanitiseTerm)
      .filter(Boolean)
      .map((w) => w.split(/\s+/).join(' <-> ')); // multi-word aliases stay phrases
    const unique = [...new Set(forms)];
    return `(${unique.map((w) => `${w}:*`).join(' | ')})`;
  });
  return groups.join(' & ');
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface ProductSearchInput {
  raw: string;
  /** Parsed filters the shopper dismissed by removing their chip. */
  drop?: SearchDroppable[];
  /** Category the shopper picked. Filters. Undefined when they picked none. */
  explicitCategoryIds?: string[];
  /** Extra constraints the caller already built (option axes, explicit price). */
  baseWhere: Prisma.ProductWhereInput;
  sort: 'popularity' | 'newest' | 'price_asc' | 'price_desc' | 'rating';
  /**
   * Whether `sort` was picked by the shopper rather than being the default.
   * A picked sort beats one the words imply; a default loses to it and only
   * breaks ties.
   */
  sortChosen?: boolean;
  skip: number;
  take: number;
}

export interface ProductSearchResult {
  /** Ids in rank order — the caller hydrates them with its own select shape. */
  ids: string[];
  total: number;
  meta: SearchMeta;
}

/** Least important first: the order filters get dropped when nothing matches. */
const RELAXATION_ORDER: SearchRelaxable[] = ['onSale', 'brands', 'minPrice', 'maxPrice'];

function describeRelaxation(dropped: SearchRelaxable[], parsed: ParsedSearchQuery): string {
  const kept: string[] = [];
  if (!dropped.includes('maxPrice') && parsed.filters.maxPricePaise != null) {
    kept.push(`under ₹${Math.round(parsed.filters.maxPricePaise / 100).toLocaleString('en-IN')}`);
  }
  if (!dropped.includes('minPrice') && parsed.filters.minPricePaise != null) {
    kept.push(`over ₹${Math.round(parsed.filters.minPricePaise / 100).toLocaleString('en-IN')}`);
  }
  if (!dropped.includes('brands') && parsed.filters.brands.length) {
    kept.push(parsed.filters.brands.join(', '));
  }
  return kept.length
    ? `No exact matches — showing results ${kept.join(' and ')} instead.`
    : 'No exact matches — showing the closest results instead.';
}

/**
 * Structured filters for one relaxation step.
 *
 * `dropped` names the filters to leave out; everything else is applied. The
 * inferred category is never in here — it only ever reaches the ranking.
 */
export function buildFilterWhere(
  parsed: ParsedSearchQuery,
  dropped: SearchRelaxable[],
): Prisma.ProductWhereInput {
  const { filters } = parsed;
  const variant: Prisma.ProductVariantWhereInput = {};
  if (!dropped.includes('minPrice') && filters.minPricePaise != null) {
    variant.pricePaise = { gte: filters.minPricePaise };
  }
  if (!dropped.includes('maxPrice') && filters.maxPricePaise != null) {
    variant.pricePaise = { ...(variant.pricePaise as object | undefined), lte: filters.maxPricePaise };
  }

  return {
    ...(Object.keys(variant).length ? { variants: { some: variant } } : {}),
    ...(!dropped.includes('brands') && filters.brands.length
      ? { brand: { in: filters.brands, mode: 'insensitive' as const } }
      : {}),
    // "on sale" means the listing carries a struck-through price above what it
    // actually costs; there is no stored discount column to filter on.
    ...(!dropped.includes('onSale') && filters.onSale ? { mrpPaise: { not: null } } : {}),
  };
}

/**
 * Run a keyword search.
 *
 * Ranking, in order of influence: full-text relevance, then a boost for the
 * guessed category, then the requested sort. Ids come back in that order and
 * the caller loads the rows — keeping the row shape in products.ts means the
 * search path and the browse path return identical products.
 */
export async function searchProducts(input: ProductSearchInput): Promise<ProductSearchResult> {
  const catalog = await searchCatalog();
  const parsedFull = parseSearchQuery(input.raw, catalog);

  // Dismissed chips are removed after parsing rather than by editing `q`.
  // The query text stays intact, so a category the words imply stays an
  // inference — dropping the price chip cannot quietly promote it to a filter.
  const drop = new Set(input.drop ?? []);
  const parsed: ParsedSearchQuery = {
    ...parsedFull,
    sort: drop.has('sort') ? null : parsedFull.sort,
    filters: {
      ...parsedFull.filters,
      ...(drop.has('minPrice') ? { minPricePaise: undefined } : {}),
      ...(drop.has('maxPrice') ? { maxPricePaise: undefined } : {}),
      ...(drop.has('brands') ? { brands: [] } : {}),
      ...(drop.has('onSale') ? { onSale: undefined } : {}),
      ...(drop.has('category') ? { inferredCategorySlug: undefined } : {}),
    },
  };

  const tsQuery = buildTsQuery(parsed.cleanedKeywords);

  // The dropdown beats the words, the words beat the default. parsed.sort is
  // already null if the shopper removed its chip.
  const appliedSort: ProductSort | null = input.sortChosen ? input.sort : parsed.sort;
  const sortSource: SearchMeta['sortSource'] = input.sortChosen
    ? 'chosen'
    : parsed.sort
      ? 'parsed'
      : 'relevance';

  // The guessed category, resolved to the ids it covers — for ranking only.
  let inferredIds: string[] = [];
  if (parsed.filters.inferredCategorySlug) {
    const { descendantIds } = await import('./categoryRules');
    const match = await prisma.category.findUnique({
      where: { slug: parsed.filters.inferredCategorySlug },
      select: { id: true },
    });
    if (match) inferredIds = await descendantIds(match.id);
  }

  const dropped: SearchRelaxable[] = [];
  let rows: { id: string; outside: boolean }[] = [];
  let total = 0;
  let strategy: SearchMeta['strategy'] = tsQuery ? 'fts' : 'filters-only';

  // Try the query as asked, then loosen one filter at a time.
  for (let step = 0; step <= RELAXATION_ORDER.length; step++) {
    const filterWhere = buildFilterWhere(parsed, dropped);
    const where: Prisma.ProductWhereInput = { ...input.baseWhere, ...filterWhere };
    const useKeywords = Boolean(tsQuery) && !dropped.includes('keywords');

    const candidates = await prisma.product.findMany({ where, select: { id: true } });
    const candidateIds = candidates.map((c) => c.id);

    if (candidateIds.length > 0) {
      const ranked = useKeywords
        ? await rankByText(
            candidateIds,
            tsQuery,
            parsed.cleanedKeywords,
            inferredIds,
            appliedSort,
            input,
            catalog,
          )
        : await rankWithoutText(candidateIds, inferredIds, appliedSort, input, catalog);

      if (ranked.matched.length > 0) {
        strategy = useKeywords ? ranked.strategy : 'filters-only';
        total = ranked.matched.length;
        const inferredCategorySet = new Set(inferredIds);
        rows = ranked.matched.slice(input.skip, input.skip + input.take).map((id) => ({
          id,
          outside:
            inferredIds.length > 0 && !inferredCategorySet.has(ranked.categoryOf.get(id) ?? ''),
        }));
        break;
      }
    }

    // Nothing yet — drop the next least important filter and try again.
    const next = RELAXATION_ORDER[step];
    if (next === undefined) break;
    const isActive =
      (next === 'onSale' && parsed.filters.onSale) ||
      (next === 'brands' && parsed.filters.brands.length > 0) ||
      (next === 'minPrice' && parsed.filters.minPricePaise != null) ||
      (next === 'maxPrice' && parsed.filters.maxPricePaise != null);
    if (isActive) dropped.push(next);
  }

  const relaxed: SearchRelaxation | null = dropped.length
    ? { dropped, message: describeRelaxation(dropped, parsed) }
    : null;

  return {
    ids: rows.map((r) => r.id),
    total,
    meta: {
      raw: input.raw,
      parsed,
      strategy: total === 0 ? 'none' : strategy,
      relaxed,
      appliedSort,
      sortSource,
      outsideInferredCategory: rows.filter((r) => r.outside).length,
    },
  };
}

/** Bayesian rating expression, shared by both ranking paths. */
function bayesianSql(meanRating: number): Prisma.Sql {
  return Prisma.sql`((p."ratingCount" * p."ratingAvg") + ${PRIOR_REVIEWS} * ${meanRating}) / (p."ratingCount" + ${PRIOR_REVIEWS})`;
}

/** ORDER BY tail for the requested sort. Price sorts keep their existing meaning. */
function sortSql(sort: ProductSearchInput['sort'], meanRating: number): Prisma.Sql {
  switch (sort) {
    case 'rating':
      // Unreviewed products rank last. The blend on its own parks them on the
      // catalog mean, which floats something nobody has rated above a product
      // with a real but below-average score. "Best" should rank on evidence,
      // and no reviews is an absence of evidence, not an average verdict.
      return Prisma.sql`(p."ratingCount" > 0) DESC, ${bayesianSql(meanRating)} DESC, p."ratingCount" DESC`;
    case 'popularity':
      return Prisma.sql`p."soldCount" DESC`;
    case 'price_asc':
      return Prisma.sql`p."basePricePaise" ASC`;
    case 'price_desc':
      return Prisma.sql`p."basePricePaise" DESC`;
    case 'newest':
    default:
      return Prisma.sql`p."createdAt" DESC`;
  }
}

/** id -> categoryId, for judging which rows came from outside the guess. */
function mapCategories(rows: { id: string; categoryId: string }[]): Map<string, string> {
  return new Map(rows.map((r) => [r.id, r.categoryId]));
}

interface Ranked {
  /** Product ids, best first. */
  matched: string[];
  /** Product id -> its category id, so membership can be judged per row. */
  categoryOf: Map<string, string>;
  strategy: SearchMeta['strategy'];
}

/**
 * ORDER BY for one ranking path.
 *
 * A sort in effect — chosen from the dropdown, or implied by the words — leads,
 * and relevance only breaks its ties. With neither, relevance leads and the
 * listing's default breaks ties.
 *
 * Sort-as-tie-breaker was the old arrangement, and it applied nothing: the
 * category boost and ts_rank almost never tie, so "phone" sorted cheapest-first
 * put the cheapest phone seventh — and "best phone" put the best-rated phone
 * seventh too, behind six from whichever smartphone tree the guess preferred.
 */
function orderSql(
  relevance: Prisma.Sql[],
  applied: ProductSort | null,
  input: ProductSearchInput,
  catalog: CachedCatalog,
): Prisma.Sql {
  const parts = applied
    ? [sortSql(applied, catalog.meanRating), ...relevance]
    : [...relevance, sortSql(input.sort, catalog.meanRating)];
  return Prisma.join(parts, ', ');
}

/** Full-text ranking, falling back to trigram similarity when it finds nothing. */
async function rankByText(
  candidateIds: string[],
  tsQuery: string,
  rawKeywords: string,
  inferredIds: string[],
  applied: ProductSort | null,
  input: ProductSearchInput,
  catalog: CachedCatalog,
): Promise<Ranked> {
  const boost = Prisma.sql`CASE WHEN p."categoryId" = ANY(${inferredIds}::text[]) THEN 1 ELSE 0 END`;
  const rank = Prisma.sql`ts_rank(p."searchVector", to_tsquery('english', ${tsQuery}))`;

  const fts = await prisma.$queryRaw<{ id: string; categoryId: string }[]>`
    SELECT p.id, p."categoryId"
    FROM products p
    WHERE p.id = ANY(${candidateIds}::text[])
      AND p."searchVector" @@ to_tsquery('english', ${tsQuery})
    ORDER BY ${orderSql([Prisma.sql`${boost} DESC`, Prisma.sql`${rank} DESC`], applied, input, catalog)}
  `;
  if (fts.length > 0) {
    return { matched: fts.map((r) => r.id), categoryOf: mapCategories(fts), strategy: 'fts' };
  }

  // Nothing matched as written — try it as a possible typo.
  const needle = rawKeywords.toLowerCase().trim();
  if (!needle) return { matched: [], categoryOf: new Map(), strategy: 'none' };

  const similarity = Prisma.sql`GREATEST(
    word_similarity(${needle}, lower(p.title)),
    word_similarity(${needle}, lower(coalesce(p.brand, '')))
  )`;
  const fuzzy = await prisma.$queryRaw<{ id: string; categoryId: string }[]>`
    SELECT p.id, p."categoryId"
    FROM products p
    WHERE p.id = ANY(${candidateIds}::text[])
      AND ${similarity} >= ${TRIGRAM_THRESHOLD}
    ORDER BY ${orderSql([Prisma.sql`${boost} DESC`, Prisma.sql`${similarity} DESC`], applied, input, catalog)}
  `;
  return {
    matched: fuzzy.map((r) => r.id),
    categoryOf: mapCategories(fuzzy),
    strategy: fuzzy.length > 0 ? 'trigram' : 'none',
  };
}

/** Ordering when the query was all filters and no words. */
async function rankWithoutText(
  candidateIds: string[],
  inferredIds: string[],
  applied: ProductSort | null,
  input: ProductSearchInput,
  catalog: CachedCatalog,
): Promise<Ranked> {
  const boost = Prisma.sql`CASE WHEN p."categoryId" = ANY(${inferredIds}::text[]) THEN 1 ELSE 0 END`;
  const rows = await prisma.$queryRaw<{ id: string; categoryId: string }[]>`
    SELECT p.id, p."categoryId"
    FROM products p
    WHERE p.id = ANY(${candidateIds}::text[])
    ORDER BY ${orderSql([Prisma.sql`${boost} DESC`], applied, input, catalog)}
  `;
  return { matched: rows.map((r) => r.id), categoryOf: mapCategories(rows), strategy: 'filters-only' };
}

// ---------------------------------------------------------------------------
// Extra facets (search only — browse keeps the facets it already had)
// ---------------------------------------------------------------------------

export async function searchFacets(where: Prisma.ProductWhereInput) {
  const [brandGroups, categoryGroups, categories, ratings, buckets] = await Promise.all([
    prisma.product.groupBy({ by: ['brand'], where, _count: { _all: true } }),
    prisma.product.groupBy({ by: ['categoryId'], where, _count: { _all: true } }),
    prisma.category.findMany({ select: { id: true, name: true, slug: true } }),
    Promise.all(
      [4, 3, 2].map(async (minRating) => ({
        minRating,
        count: await prisma.product.count({ where: { ...where, ratingAvg: { gte: minRating } } }),
      })),
    ),
    Promise.all(
      PRICE_BUCKETS.map(async (bucket) => ({
        ...bucket,
        count: await prisma.product.count({
          where: {
            ...where,
            variants: {
              some: {
                ...(bucket.minPaise != null ? { pricePaise: { gte: bucket.minPaise } } : {}),
                ...(bucket.maxPaise != null
                  ? { pricePaise: { lte: bucket.maxPaise, ...(bucket.minPaise != null ? { gte: bucket.minPaise } : {}) } }
                  : {}),
              },
            },
          },
        }),
      })),
    ),
  ]);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  return {
    brands: brandGroups
      .flatMap((g) => (g.brand ? [{ name: g.brand, count: g._count._all }] : []))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    categories: categoryGroups
      .flatMap((g) => {
        const category = categoryById.get(g.categoryId);
        return category ? [{ name: category.name, slug: category.slug, count: g._count._all }] : [];
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    ratings: ratings.filter((r) => r.count > 0),
    priceBuckets: buckets.filter((b) => b.count > 0),
  };
}
