import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  SEARCH_SORT_LABELS,
  SUGGEST_GROUP_LIMIT,
  describeParsedQuery,
  parseSuggestQuery,
  suggestQuerySchema,
  type BrandSuggestion,
  type CategorySuggestion,
  type ProductSuggestion,
  type SuggestResponse,
  type SuggestTerms,
  type SuggestUnderstood,
} from '@clowe/shared';
import { prisma } from '../db';
import { suggestLimiter } from '../middleware/rateLimits';
import { buildFilterWhere, searchCatalog, searchProducts } from '../services/productSearch';

export const searchRouter = Router();
searchRouter.use(suggestLimiter);

/**
 * Same visibility rule the storefront listing uses. A suggestion that leads to
 * a 404 is worse than no suggestion, so this must not drift from products.ts.
 */
const LIVE = {
  status: 'APPROVED' as const,
  isVisible: true,
  seller: { vacationMode: false },
};

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/**
 * Suggestions are answered from memory wherever possible.
 *
 * This endpoint fires on every keystroke, so the budget is a few milliseconds.
 * Brands and categories already live in the search catalog cache and need no
 * query at all; only the product lookup touches the database, and its results
 * are cached per prefix for a minute because many shoppers type the same few.
 */
const SUGGEST_TTL_MS = 60 * 1000;
const SUGGEST_CACHE_MAX = 500;
const suggestCache = new Map<string, { value: SuggestResponse; expires: number }>();

function cacheGet(key: string): SuggestResponse | null {
  const hit = suggestCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    suggestCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: SuggestResponse): void {
  // Plain FIFO eviction: the key space is short prefixes, so a cheap bound is
  // enough to stop a scraper growing this without limit.
  if (suggestCache.size >= SUGGEST_CACHE_MAX) {
    const oldest = suggestCache.keys().next().value;
    if (oldest !== undefined) suggestCache.delete(oldest);
  }
  suggestCache.set(key, { value, expires: Date.now() + SUGGEST_TTL_MS });
}

/** Best sellers for the dropdown's empty state, refreshed on the same clock. */
let trendingCache: { value: ProductSuggestion[]; expires: number } | null = null;

async function trendingProducts(): Promise<ProductSuggestion[]> {
  if (trendingCache && trendingCache.expires > Date.now()) return trendingCache.value;
  const rows = await prisma.product.findMany({
    where: LIVE,
    orderBy: { soldCount: 'desc' },
    take: SUGGEST_GROUP_LIMIT,
    select: SUGGEST_SELECT,
  });
  const value = rows.map(toSuggestion);
  trendingCache = { value, expires: Date.now() + SUGGEST_TTL_MS };
  return value;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const SUGGEST_SELECT = {
  id: true,
  title: true,
  slug: true,
  basePricePaise: true,
  images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
  variants: { orderBy: { pricePaise: 'asc' }, take: 1, select: { pricePaise: true } },
} satisfies Prisma.ProductSelect;

interface SuggestRow {
  id: string;
  title: string;
  slug: string;
  basePricePaise: number;
  images: { url: string }[];
  variants: { pricePaise: number }[];
}

function toSuggestion(row: SuggestRow): ProductSuggestion {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    imageUrl: row.images[0]?.url ?? null,
    pricePaise: row.variants[0]?.pricePaise ?? row.basePricePaise,
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * A substring filter the database can answer from the trigram index.
 *
 * Deliberately looser than the real rule: a whole-word term still comes back
 * with its mid-word matches, and matchesAllTerms drops those afterwards.
 * Postgres can index "contains" here but not a word-boundary regex, so the
 * narrowing that needs a regex happens in memory over a few dozen rows.
 */
function titleWhere(terms: SuggestTerms): Prisma.ProductWhereInput {
  return {
    AND: terms.map((term) => ({
      OR: term.any.map((word) => ({ title: { contains: word, mode: 'insensitive' as const } })),
    })),
  };
}

const boundaryCache = new Map<string, RegExp>();

function boundary(word: string): RegExp {
  let re = boundaryCache.get(word);
  if (!re) {
    re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    boundaryCache.set(word, re);
  }
  return re;
}

/** The real rule: finished words must land on a word boundary, fragments need not. */
function matchesAllTerms(text: string, terms: SuggestTerms): boolean {
  const lower = text.toLowerCase();
  return terms.every((term) =>
    term.any.some((word) => (term.whole ? boundary(word).test(lower) : lower.includes(word))),
  );
}

/**
 * Lower is better: a title starting with what was typed beats one where the
 * match starts a later word, which beats a match buried mid-word. Typing "sma"
 * should offer "Smartphone" before "Aerisma".
 */
function rankPrefix(text: string, needle: string): number {
  const lower = text.toLowerCase();
  if (lower.startsWith(needle)) return 0;
  if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lower)) return 1;
  return 2;
}

/** Best rank any of the terms achieves — one strong match is enough to lead. */
function rankTerms(text: string, terms: SuggestTerms): number {
  let best = 3;
  for (const term of terms) {
    for (const word of term.any) best = Math.min(best, rankPrefix(text, word));
  }
  return best;
}

async function lookupProducts(
  where: Prisma.ProductWhereInput,
  terms: SuggestTerms,
): Promise<ProductSuggestion[]> {
  const rows = await prisma.product.findMany({
    where,
    // Over-fetch: the where clause is a substring superset of what actually
    // qualifies, and the prefix ranking needs something to choose from once the
    // mid-word matches have been dropped.
    take: SUGGEST_GROUP_LIMIT * 10,
    orderBy: { soldCount: 'desc' },
    select: SUGGEST_SELECT,
  });
  return rows
    .filter((row) => matchesAllTerms(row.title, terms))
    .sort((a, b) => rankTerms(a.title, terms) - rankTerms(b.title, terms))
    .slice(0, SUGGEST_GROUP_LIMIT)
    .map(toSuggestion);
}

/** Hydrate ranked ids without losing the order they came back in. */
async function hydrateRanked(ids: string[]): Promise<ProductSuggestion[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.product.findMany({ where: { id: { in: ids } }, select: SUGGEST_SELECT });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toSuggestion(row)] : [];
  });
}

// ---------------------------------------------------------------------------
// Suggest
// ---------------------------------------------------------------------------

/**
 * Type-ahead suggestions, grouped.
 *
 * Runs the same parser as the results page, so a phrase cannot mean one thing
 * in the dropdown and another on the page it leads to — "best phone" used to
 * return nothing here while the page behind it returned phones, because the
 * whole string was matched literally.
 *
 * What the parser does NOT get to do here is strip a word that is still being
 * typed; see parseSuggestQuery for where that line is drawn. What is left after
 * parsing is matched as a prefix, not ranked by full text: someone who has
 * typed "sma" has not finished a word, and tsquery ranking would be both slower
 * and wrong for a fragment.
 */
searchRouter.get('/suggest', async (req, res, next) => {
  try {
    const { q } = suggestQuerySchema.parse(req.query);

    // Nothing typed yet: the dropdown opens on best sellers.
    if (!q.trim()) {
      const body: SuggestResponse = {
        q,
        products: [],
        categories: [],
        brands: [],
        trending: await trendingProducts(),
        understood: null,
      };
      res.json({ success: true, data: body });
      return;
    }

    // The trailing space is part of the key: "best" and "best " mean different
    // things, so they cannot share a cache entry.
    const key = q.toLowerCase();
    const cached = cacheGet(key);
    if (cached) {
      res.json({ success: true, data: { ...cached, q } });
      return;
    }

    const catalog = await searchCatalog();
    const { parsed, terms } = parseSuggestQuery(q, catalog);

    const categoryName = parsed.filters.inferredCategorySlug
      ? (catalog.categoryPaths.find((c) => c.slug === parsed.filters.inferredCategorySlug)?.name ??
        null)
      : null;
    const chips = describeParsedQuery(parsed, { categoryName });

    // Brands and categories are names, not listings: the parser's price and
    // stock filters have nothing to say about them, so only the words apply.
    const brands: BrandSuggestion[] = terms.length
      ? catalog.brands
          .filter((name) => matchesAllTerms(name, terms))
          .sort((a, b) => rankTerms(a, terms) - rankTerms(b, terms) || a.localeCompare(b))
          .slice(0, SUGGEST_GROUP_LIMIT)
          .map((name) => ({ name }))
      : [];

    const categories: CategorySuggestion[] = terms.length
      ? catalog.categoryPaths
          .filter((c) => matchesAllTerms(c.name, terms))
          .sort(
            (a, b) => rankTerms(a.name, terms) - rankTerms(b.name, terms) || a.name.localeCompare(b.name),
          )
          .slice(0, SUGGEST_GROUP_LIMIT)
      : [];

    let products: ProductSuggestion[] = [];
    let productsLabel: string | null = null;

    if (terms.length > 0) {
      // Same filter semantics as the results page — buildFilterWhere is the one
      // definition of what "under 15k" or "on sale" narrows to.
      const filters = buildFilterWhere(parsed, []);
      products = await lookupProducts({ ...LIVE, ...filters, ...titleWhere(terms) }, terms);

      // A bound that is still being typed ("phone under 15" on the way to 15k)
      // can exclude everything for a keystroke or two. Showing the words without
      // the half-finished filter beats flashing "Nothing matches" at someone who
      // is mid-word — the same "never return nothing" rule the results page
      // follows when it relaxes a filter.
      if (products.length === 0 && Object.keys(filters).length > 0) {
        products = await lookupProducts({ ...LIVE, ...titleWhere(terms) }, terms);
      }
    }

    // The query said something but left nothing to prefix-match on: "best" asks
    // for the top-rated products, so show those rather than "Nothing matches".
    // Ranked by searchProducts so the order is the results page's order and not
    // a second opinion about what "best" means.
    if (products.length === 0 && brands.length === 0 && categories.length === 0 && chips.length > 0) {
      const ranked = await searchProducts({
        raw: q,
        baseWhere: LIVE,
        sort: parsed.sort ?? 'popularity',
        skip: 0,
        take: SUGGEST_GROUP_LIMIT,
      });
      products = await hydrateRanked(ranked.ids);
      productsLabel = parsed.sort ? SEARCH_SORT_LABELS[parsed.sort] : (chips[0]?.label ?? null);
    }

    const understood: SuggestUnderstood | null =
      chips.length > 0 || productsLabel ? { chips, productsLabel } : null;

    const body: SuggestResponse = { q, products, categories, brands, trending: [], understood };
    cacheSet(key, body);
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
