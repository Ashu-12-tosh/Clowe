/**
 * The wording half of query suggestions: price bounds, how amounts are
 * written, and which words a category name offers. Pure, so it can be tested
 * without a database; querySuggestions.ts does the searching.
 */

// ---------------------------------------------------------------------------
// Price bounds
// ---------------------------------------------------------------------------

/**
 * Where a bound is taken from: the price a quarter, half and three quarters of
 * the way up the list.
 *
 * Hand-picked round numbers are how a dropdown ends up offering "under 10k" for
 * phones when the cheapest phone costs 12,000 — a suggestion that leads to
 * nothing. Starting from prices that exist means there is always a product at
 * or under the bound before any rounding happens.
 */
const QUARTILES = [0.25, 0.5, 0.75] as const;

/** Below this many priced products a quartile is just one product's price. */
export const MIN_PRODUCTS_FOR_BUCKETS = 4;

/**
 * Round up to a step that matches how the amount would be said out loud:
 * nobody searches "under 13,470". Always up, never down — rounding up can only
 * bring more products under the bound, never push the one it came from out.
 */
export function niceCeilRupees(rupees: number): number {
  const step =
    rupees <= 1_000 ? 100 : rupees <= 10_000 ? 1_000 : rupees <= 100_000 ? 5_000 : 50_000;
  return Math.ceil(rupees / step) * step;
}

/**
 * How an amount is written into a phrase: "500", "15k", "1.5 lakh".
 *
 * Only forms parseSearchQuery reads back to the same number; the generator
 * checks that round trip on every phrase before keeping it.
 */
export function formatRupeesForQuery(rupees: number): string {
  if (rupees < 1_000) return String(rupees);
  if (rupees < 100_000) return `${rupees / 1_000}k`;
  return `${rupees / 100_000} lakh`;
}

/**
 * Upper price bounds, in paise, for a set of products' prices.
 *
 * Every bound returned splits the set: at least one product at or under it and
 * at least one above. A bound everything sits under narrows nothing, and two
 * bounds covering the same products would show the same page twice.
 */
export function priceBucketsPaise(pricesPaise: readonly number[]): number[] {
  const prices = [...pricesPaise].sort((a, b) => a - b);
  const n = prices.length;
  if (n < MIN_PRODUCTS_FOR_BUCKETS) return [];

  const bounds: number[] = [];
  const counts = new Set<number>();
  for (const q of QUARTILES) {
    const at = prices[Math.floor(q * (n - 1))]!;
    const bound = niceCeilRupees(Math.ceil(at / 100)) * 100;
    const count = prices.filter((price) => price <= bound).length;
    if (count >= n || counts.has(count)) continue;
    counts.add(count);
    bounds.push(bound);
  }
  return bounds;
}

// ---------------------------------------------------------------------------
// Words from category names
// ---------------------------------------------------------------------------

/**
 * Crude English singular for the last word of a name: "Watches" -> "watch",
 * "Accessories" -> "accessory", "Shoes" -> "shoe".
 *
 * Crude is enough because nothing trusts it. A wrong singular is just another
 * candidate, and the search it is put through decides whether it means
 * anything.
 */
export function singularize(phrase: string): string {
  const words = phrase.split(' ');
  const last = words[words.length - 1] ?? '';
  let single = last;
  if (last.length > 3) {
    if (/ies$/.test(last)) single = last.slice(0, -3) + 'y';
    else if (/(ss|us|is)$/.test(last)) single = last;
    else if (/(s|x|z|ch|sh)es$/.test(last)) single = last.slice(0, -2);
    else if (/s$/.test(last)) single = last.slice(0, -1);
  }
  words[words.length - 1] = single;
  return words.join(' ');
}

/**
 * Candidate search words for one category name.
 *
 * The name as written, each part of a compound name ("Bags & Wallets" gives
 * "bags" and "wallets"), and a singular of each. The name itself usually fails
 * verification — the parser treats an exact category name as a ranking hint
 * and searches no words at all — which is exactly why the singulars are here.
 */
export function categoryWords(name: string): string[] {
  const lower = name.toLowerCase().replace(/\s+/g, ' ').trim();
  const parts = lower.split(/\s*(?:&|,|\band\b)\s*/).filter(Boolean);
  const out = new Set<string>();
  for (const word of [lower, ...parts]) {
    out.add(word);
    out.add(singularize(word));
  }
  return [...out];
}
