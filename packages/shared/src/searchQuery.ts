import { z } from 'zod';
import { productSortValues, type ProductSort } from './catalog';

/**
 * Turns what a shopper actually types into structured filters.
 *
 * "best phone under 15k" is one string to a LIKE query and matches nothing.
 * Split into { keywords: "", category: mobiles, maxPricePaise: 1_500_000,
 * sort: rating } it matches plenty. Both the search bar and voice search run
 * through here, so a phrase means the same thing however it arrives.
 *
 * Pure by design: the caller injects the brand and category lists, so this
 * never touches a database and stays trivially testable.
 *
 * MONEY: every amount out of this module is in PAISE, matching how prices are
 * stored. Rupees only exist inside parseAmountToRupees and are converted once,
 * at the point of capture.
 */

// ---------------------------------------------------------------------------
// Synonyms — the one place to edit when shoppers use a word we don't know.
// ---------------------------------------------------------------------------

/**
 * `aliases` are what people type; `canonical` is what we search for instead.
 * `categorySlug` is a hint: applied only when that slug exists in the injected
 * catalog, so this map can name categories a given deployment may not have.
 */
export interface SynonymEntry {
  canonical: string;
  aliases: string[];
  categorySlug?: string;
}

export const SEARCH_SYNONYMS: SynonymEntry[] = [
  {
    canonical: 'smartphone',
    aliases: ['phone', 'phones', 'mobile', 'mobiles', 'smartphones', 'cellphone', 'cell phone', 'handset', 'handsets'],
    categorySlug: 'mobiles',
  },
  {
    canonical: 'television',
    aliases: ['tv', 'tvs', 'televisions', 'led tv', 'smart tv'],
    categorySlug: 'electronics-tvs',
  },
  {
    canonical: 'refrigerator',
    aliases: ['fridge', 'fridges', 'refrigerators'],
    categorySlug: 'electronics-appliances',
  },
  {
    canonical: 'laptop',
    aliases: ['laptops', 'notebook', 'notebooks', 'ultrabook'],
    categorySlug: 'electronics-laptops',
  },
  {
    canonical: 'headphone',
    aliases: ['headphones', 'earphone', 'earphones', 'earbud', 'earbuds', 'headset', 'headsets'],
    categorySlug: 'electronics-headphones',
  },
  { canonical: 'tablet', aliases: ['tablets', 'tab', 'ipad', 'ipads'], categorySlug: 'electronics-tablets' },
  { canonical: 'washing machine', aliases: ['washer', 'washers', 'washing machines'] },
  { canonical: 'air conditioner', aliases: ['ac', 'acs', 'air conditioners', 'air conditioning'] },
  { canonical: 'microwave', aliases: ['oven', 'ovens', 'microwaves', 'otg'] },
  { canonical: 'shoe', aliases: ['shoes', 'sneaker', 'sneakers', 'footwear', 'trainers'] },
  { canonical: 'watch', aliases: ['watches', 'wristwatch', 'smartwatch', 'smartwatches'] },
  { canonical: 'trouser', aliases: ['trousers', 'pant', 'pants', 'chinos'] },
  { canonical: 'tshirt', aliases: ['t-shirt', 't shirt', 'tee', 'tees', 'tshirts', 't-shirts'] },
  { canonical: 'speaker', aliases: ['speakers', 'soundbar', 'soundbars', 'bluetooth speaker'] },
  { canonical: 'camera', aliases: ['cameras', 'dslr', 'dslrs'] },
  { canonical: 'perfume', aliases: ['perfumes', 'fragrance', 'fragrances', 'deo', 'deodorant'] },
];

// ---------------------------------------------------------------------------
// Intent words -> sort order
// ---------------------------------------------------------------------------

/**
 * Longest phrases first: "top rated" has to win over "top" so the leftover
 * "rated" never reaches the keywords.
 *
 * 'rating' is deliberately the target for best/top. What "rating" *means* is
 * the search endpoint's business — it weights by review count so one 5-star
 * review cannot top the list — and keeping the name lets that change without
 * touching the parser.
 */
const INTENT_TO_SORT: { phrase: string; sort: ProductSort }[] = [
  { phrase: 'top rated', sort: 'rating' },
  { phrase: 'top-rated', sort: 'rating' },
  { phrase: 'highest rated', sort: 'rating' },
  { phrase: 'best rated', sort: 'rating' },
  { phrase: 'best selling', sort: 'popularity' },
  { phrase: 'bestselling', sort: 'popularity' },
  { phrase: 'best seller', sort: 'popularity' },
  { phrase: 'most popular', sort: 'popularity' },
  { phrase: 'lowest price', sort: 'price_asc' },
  { phrase: 'least expensive', sort: 'price_asc' },
  { phrase: 'most expensive', sort: 'price_desc' },
  { phrase: 'best', sort: 'rating' },
  { phrase: 'top', sort: 'rating' },
  { phrase: 'popular', sort: 'popularity' },
  { phrase: 'trending', sort: 'popularity' },
  { phrase: 'cheapest', sort: 'price_asc' },
  { phrase: 'cheap', sort: 'price_asc' },
  { phrase: 'latest', sort: 'newest' },
  { phrase: 'newest', sort: 'newest' },
];

const DISCOUNT_PHRASES = [
  'on sale',
  'discounted',
  'discount',
  'offers',
  'offer',
  'deals',
  'deal',
  'sale',
  'bargain',
];

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  thousands: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  lacs: 100_000,
  crore: 10_000_000,
  crores: 10_000_000,
  cr: 10_000_000,
};

const CURRENCY = String.raw`(?:₹|rs\.?|inr|rupees?)`;
const SUFFIX = String.raw`(?:k|thousands?|lakhs?|lacs?|crores?|cr)`;
/**
 * One money amount: optional currency, an Indian-grouped or plain number with
 * an optional decimal, and an optional magnitude suffix.
 *
 * The trailing lookahead is what stops "15kg" being read as 15,000: with the
 * suffix consumed the next char is `g`, and without it the next char is `k`,
 * so neither branch can complete.
 */
const AMOUNT = String.raw`${CURRENCY}?\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(${SUFFIX})?(?![a-z0-9])`;

/** Rupees for one captured amount. `15`+`k` -> 15000; `1.5`+`lakh` -> 150000. */
function parseAmountToRupees(digits: string, suffix: string | undefined): number {
  const base = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(base)) return NaN;
  const multiplier = suffix ? (MULTIPLIERS[suffix.toLowerCase()] ?? 1) : 1;
  return base * multiplier;
}

/** The only rupees -> paise conversion in this module. */
function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** True when an amount carried a suffix or a currency marker. */
function looksLikeMoney(fullMatch: string, suffix: string | undefined): boolean {
  return Boolean(suffix) || /₹|rs|inr|rupee/i.test(fullMatch);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const parsedSearchFiltersSchema = z.object({
  /** Inclusive lower bound, in paise. */
  minPricePaise: z.number().int().min(0).optional(),
  /** Inclusive upper bound, in paise. */
  maxPricePaise: z.number().int().min(0).optional(),
  /** Brand names exactly as they appear in the catalog. */
  brands: z.array(z.string()).default([]),
  /**
   * Category the parser *guessed* from the words used ("phone" -> mobiles).
   *
   * Deliberately NOT named categorySlug: a guess may only rank results, never
   * remove them. This catalog keeps smartphones under two different parents,
   * so filtering on an inferred slug would hide over half of them. The user's
   * own explicit choice travels separately, as ProductListQuery.category, and
   * that one does filter. Two names so the two meanings cannot be swapped by
   * accident.
   */
  inferredCategorySlug: z.string().optional(),
  /** The shopper asked for discounted items. */
  onSale: z.boolean().optional(),
});
export type ParsedSearchFilters = z.infer<typeof parsedSearchFiltersSchema>;

export const parsedSearchQuerySchema = z.object({
  /** What is left to match against product text; '' when the query was all filters. */
  cleanedKeywords: z.string(),
  filters: parsedSearchFiltersSchema,
  /** null when the query implied no ordering — the caller keeps its default. */
  sort: z.enum(productSortValues).nullable(),
});
export type ParsedSearchQuery = z.infer<typeof parsedSearchQuerySchema>;

/** Brands and categories the parser matches against. */
export interface SearchCatalog {
  brands: string[];
  categories: { slug: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Regex-escape a catalog term so brand names with dots or + are literal. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collapse the gaps left behind by everything we removed. */
function tidy(text: string): string {
  return text
    .replace(/[\s,]+/g, ' ')
    .replace(/\s*-\s*$/, '')
    .trim();
}

const MAX_WORDS = String.raw`(?:under|below|less than|lesser than|upto|up to|within|max|maximum|at most|cheaper than|not more than|no more than)`;
const MIN_WORDS = String.raw`(?:above|over|more than|greater than|starting at|starting from|min|minimum|at least|upwards of)`;

export function parseSearchQuery(raw: string, catalog: SearchCatalog): ParsedSearchQuery {
  const original = (raw ?? '').trim();
  let text = ` ${original.toLowerCase()} `;

  const filters: ParsedSearchFilters = { brands: [] };
  let sort: ProductSort | null = null;

  // -- 1. Price -------------------------------------------------------------
  // Ranges first: "between 10k and 20k" also contains a bare "10k", so a
  // single-bound pattern would otherwise eat half of it.

  // "between 10k and 20k", "from 10k to 20k"
  text = text.replace(
    new RegExp(String.raw`\b(?:between|from)\s+${AMOUNT}\s*(?:and|to|-|–)\s*${AMOUNT}`, 'gi'),
    (_m, d1: string, s1: string | undefined, d2: string, s2: string | undefined) => {
      const a = parseAmountToRupees(d1, s1);
      const b = parseAmountToRupees(d2, s2);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return ' ';
      filters.minPricePaise = toPaise(Math.min(a, b));
      filters.maxPricePaise = toPaise(Math.max(a, b));
      return ' ';
    },
  );

  // Bare range: "10k-20k", "10k to 20k". Guarded so a model number such as
  // "iphone 12-15" is not read as a price: at least one side must carry a
  // suffix or currency, or both sides must be big enough to be prices.
  if (filters.maxPricePaise === undefined) {
    text = text.replace(
      new RegExp(String.raw`${AMOUNT}\s*(?:-|–|to)\s*${AMOUNT}`, 'gi'),
      (match, d1: string, s1: string | undefined, d2: string, s2: string | undefined) => {
        const a = parseAmountToRupees(d1, s1);
        const b = parseAmountToRupees(d2, s2);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return match;
        const marked = looksLikeMoney(match, s1) || looksLikeMoney(match, s2);
        if (!marked && (a < 1_000 || b < 1_000)) return match;
        filters.minPricePaise = toPaise(Math.min(a, b));
        filters.maxPricePaise = toPaise(Math.max(a, b));
        return ' ';
      },
    );
  }

  // "under 15k", "below ₹15,000", "upto 15k"
  text = text.replace(
    new RegExp(String.raw`\b${MAX_WORDS}\s+${AMOUNT}`, 'gi'),
    (_m, digits: string, suffix: string | undefined) => {
      const rupees = parseAmountToRupees(digits, suffix);
      if (Number.isFinite(rupees)) filters.maxPricePaise = toPaise(rupees);
      return ' ';
    },
  );

  // "above 20k", "over 20000"
  text = text.replace(
    new RegExp(String.raw`\b${MIN_WORDS}\s+${AMOUNT}`, 'gi'),
    (_m, digits: string, suffix: string | undefined) => {
      const rupees = parseAmountToRupees(digits, suffix);
      if (Number.isFinite(rupees)) filters.minPricePaise = toPaise(rupees);
      return ' ';
    },
  );

  // -- 2. Discount ----------------------------------------------------------
  for (const phrase of DISCOUNT_PHRASES) {
    const re = new RegExp(String.raw`\b${escapeRegex(phrase)}\b`, 'gi');
    if (re.test(text)) {
      filters.onSale = true;
      text = text.replace(re, ' ');
    }
  }

  // -- 3. Catalog ------------------------------------------------------------
  // Before intent words, so a category genuinely called "Tops" wins over
  // "top" the ranking hint.

  const brandsByLength = [...catalog.brands].sort((a, b) => b.length - a.length);
  for (const brand of brandsByLength) {
    if (!brand.trim()) continue;
    const re = new RegExp(String.raw`\b${escapeRegex(brand.toLowerCase())}\b`, 'gi');
    if (re.test(text)) {
      if (!filters.brands.includes(brand)) filters.brands.push(brand);
      text = text.replace(re, ' ');
    }
  }

  const categoriesByLength = [...catalog.categories].sort((a, b) => b.name.length - a.name.length);
  for (const category of categoriesByLength) {
    if (!category.name.trim()) continue;
    const re = new RegExp(String.raw`\b${escapeRegex(category.name.toLowerCase())}\b`, 'gi');
    if (re.test(text)) {
      filters.inferredCategorySlug ??= category.slug;
      text = text.replace(re, ' ');
    }
  }

  // -- 4. Intent ------------------------------------------------------------
  for (const { phrase, sort: candidate } of INTENT_TO_SORT) {
    const re = new RegExp(String.raw`\b${escapeRegex(phrase)}\b`, 'gi');
    if (re.test(text)) {
      sort ??= candidate;
      text = text.replace(re, ' ');
    }
  }

  // -- 5. Synonyms ----------------------------------------------------------
  // Rewrite what people say into what the catalog calls it, and take the
  // category hint when this deployment actually has that category.
  const knownSlugs = new Set(catalog.categories.map((c) => c.slug));
  for (const entry of SEARCH_SYNONYMS) {
    const aliases = [...entry.aliases].sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      const re = new RegExp(String.raw`\b${escapeRegex(alias)}\b`, 'gi');
      if (!re.test(text)) continue;
      text = text.replace(re, ` ${entry.canonical} `);
      if (entry.categorySlug && knownSlugs.has(entry.categorySlug)) {
        filters.inferredCategorySlug ??= entry.categorySlug;
      }
    }
  }

  // -- 6. What is left is the keywords --------------------------------------
  const cleanedKeywords = tidy(text);

  return {
    // A query that parsed into nothing but filters leaves no keywords, which
    // is correct: "under 15k" should not also search for the word "under".
    cleanedKeywords,
    filters,
    sort,
  };
}
