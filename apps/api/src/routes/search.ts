import { Router } from 'express';
import {
  SUGGEST_GROUP_LIMIT,
  suggestQuerySchema,
  type BrandSuggestion,
  type CategorySuggestion,
  type ProductSuggestion,
  type SuggestResponse,
} from '@clowe/shared';
import { prisma } from '../db';
import { suggestLimiter } from '../middleware/rateLimits';
import { searchCatalog } from '../services/productSearch';

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
    select: {
      id: true,
      title: true,
      slug: true,
      basePricePaise: true,
      images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
      variants: { orderBy: { pricePaise: 'asc' }, take: 1, select: { pricePaise: true } },
    },
  });
  const value = rows.map(toSuggestion);
  trendingCache = { value, expires: Date.now() + SUGGEST_TTL_MS };
  return value;
}

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
// Suggest
// ---------------------------------------------------------------------------

/**
 * Type-ahead suggestions, grouped.
 *
 * Prefix matching, not full-text: someone who has typed "sma" has not finished
 * a word, and tsquery ranking would be both slower and wrong for a fragment.
 * The results page does the ranked search; this only has to guess what is
 * being typed.
 */
searchRouter.get('/suggest', async (req, res, next) => {
  try {
    const { q } = suggestQuerySchema.parse(req.query);
    const needle = q.toLowerCase().trim();

    // Nothing typed yet: the dropdown opens on best sellers.
    if (!needle) {
      const body: SuggestResponse = {
        q,
        products: [],
        categories: [],
        brands: [],
        trending: await trendingProducts(),
      };
      res.json({ success: true, data: body });
      return;
    }

    const cached = cacheGet(needle);
    if (cached) {
      res.json({ success: true, data: { ...cached, q } });
      return;
    }

    const catalog = await searchCatalog();

    // Brands and categories come from the cached catalog — no query needed for
    // 36 brands and 67 categories.
    const brands: BrandSuggestion[] = catalog.brands
      .filter((name) => name.toLowerCase().includes(needle))
      .sort((a, b) => rankPrefix(a, needle) - rankPrefix(b, needle) || a.localeCompare(b))
      .slice(0, SUGGEST_GROUP_LIMIT)
      .map((name) => ({ name }));

    const categories: CategorySuggestion[] = catalog.categoryPaths
      .filter((c) => c.name.toLowerCase().includes(needle))
      .sort((a, b) => rankPrefix(a.name, needle) - rankPrefix(b.name, needle) || a.name.localeCompare(b.name))
      .slice(0, SUGGEST_GROUP_LIMIT);

    // Only the product lookup hits the database. ILIKE '%needle%' rides the
    // trigram GIN index added with the search migration.
    const rows = await prisma.product.findMany({
      where: { ...LIVE, title: { contains: needle, mode: 'insensitive' } },
      // Over-fetch a little so the in-memory prefix ranking has something to
      // choose from, then cut to the group limit.
      take: SUGGEST_GROUP_LIMIT * 4,
      orderBy: { soldCount: 'desc' },
      select: {
        id: true,
        title: true,
        slug: true,
        basePricePaise: true,
        images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
        variants: { orderBy: { pricePaise: 'asc' }, take: 1, select: { pricePaise: true } },
      },
    });

    const products = rows
      .sort((a, b) => rankPrefix(a.title, needle) - rankPrefix(b.title, needle))
      .slice(0, SUGGEST_GROUP_LIMIT)
      .map(toSuggestion);

    const body: SuggestResponse = { q, products, categories, brands, trending: [] };
    cacheSet(needle, body);
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

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
