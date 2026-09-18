import { parseSearchQuery } from '@clowe/shared';
import { describe, expect, it } from 'vitest';
import {
  MIN_PRODUCTS_FOR_BUCKETS,
  categoryWords,
  formatRupeesForQuery,
  niceCeilRupees,
  priceBucketsPaise,
  singularize,
} from './suggestionPhrasing';

const rupees = (paise: number) => paise / 100;
const paise = (r: number) => r * 100;

// ---------------------------------------------------------------------------
// Price bounds. The rule these guard: a suggested "under X" always has
// something under X. The original bug was a search that returned nothing; a
// suggestion that does the same is that bug again.
// ---------------------------------------------------------------------------

describe('price bounds come from what things actually cost', () => {
  // Illustrative prices, in rupees, with the same floor as the live catalog's
  // phones: nothing under 12,070.
  const phones = [12_070, 13_000, 38_860, 40_470, 45_990, 52_300, 64_100, 69_090].map(paise);

  it('never offers a bound below the cheapest product', () => {
    const cheapest = Math.min(...phones);
    for (const bound of priceBucketsPaise(phones)) expect(bound).toBeGreaterThanOrEqual(cheapest);
  });

  it('puts at least one product under every bound', () => {
    for (const bound of priceBucketsPaise(phones)) {
      expect(phones.filter((p) => p <= bound).length).toBeGreaterThan(0);
    }
  });

  it('leaves at least one product above every bound — otherwise it narrows nothing', () => {
    for (const bound of priceBucketsPaise(phones)) {
      expect(phones.filter((p) => p > bound).length).toBeGreaterThan(0);
    }
  });

  it('does not offer "under 10k" when nothing costs under 10k', () => {
    expect(priceBucketsPaise(phones)).not.toContain(paise(10_000));
    expect(priceBucketsPaise(phones).every((b) => rupees(b) >= 12_070)).toBe(true);
  });

  it('never offers two bounds that cover the same products', () => {
    const bounds = priceBucketsPaise(phones);
    const counts = bounds.map((b) => phones.filter((p) => p <= b).length);
    expect(new Set(counts).size).toBe(counts.length);
  });

  it('offers nothing when there are too few products to have a distribution', () => {
    expect(priceBucketsPaise(phones.slice(0, MIN_PRODUCTS_FOR_BUCKETS - 1))).toEqual([]);
  });

  it('offers nothing when every product costs the same', () => {
    expect(priceBucketsPaise([paise(999), paise(999), paise(999), paise(999)])).toEqual([]);
  });
});

describe('amounts are rounded the way people say them, and only upward', () => {
  it.each([
    [640, 700],
    [3_000, 3_000],
    [3_001, 4_000],
    [12_070, 15_000],
    [40_470, 45_000],
    [123_456, 150_000],
  ])('%i -> %i', (input, expected) => {
    expect(niceCeilRupees(input)).toBe(expected);
    expect(niceCeilRupees(input)).toBeGreaterThanOrEqual(input);
  });
});

describe('an amount reads back through the parser as the same amount', () => {
  // The generator checks this for every phrase at build time; this pins the
  // formats themselves, so a change to either side fails here first.
  const empty = { brands: [], categories: [] };
  it.each([500, 700, 3_000, 15_000, 45_000, 100_000, 150_000, 250_000])('%i', (amount) => {
    const text = formatRupeesForQuery(amount);
    const parsed = parseSearchQuery(`phone under ${text}`, empty);
    expect(parsed.filters.maxPricePaise).toBe(amount * 100);
  });

  it('writes thousands as k and lakhs as lakh', () => {
    expect(formatRupeesForQuery(15_000)).toBe('15k');
    expect(formatRupeesForQuery(150_000)).toBe('1.5 lakh');
    expect(formatRupeesForQuery(700)).toBe('700');
  });
});

describe('words from category names', () => {
  it.each([
    ['watches', 'watch'],
    ['accessories', 'accessory'],
    ['shoes', 'shoe'],
    ['dresses', 'dress'],
    ['glass', 'glass'],
    ['home appliances', 'home appliance'],
    ['tv', 'tv'],
  ])('%s -> %s', (plural, single) => {
    expect(singularize(plural)).toBe(single);
  });

  it('splits compound names into their parts', () => {
    expect(categoryWords('Bags & Wallets')).toEqual(
      expect.arrayContaining(['bags & wallets', 'bags', 'bag', 'wallets', 'wallet']),
    );
  });
});
