import { describe, expect, it } from 'vitest';
import { parseSearchQuery, type SearchCatalog } from './searchQuery';

/**
 * A stand-in for what the backend will inject from the database. Deliberately
 * small, and deliberately includes "Tops" so the "top" ranking word cannot
 * swallow a real category name.
 */
const catalog: SearchCatalog = {
  brands: ['Samsung', 'Apple', 'NovaTech', 'Zephyr', 'Casa Nova'],
  categories: [
    { slug: 'mobiles', name: 'Mobiles' },
    { slug: 'electronics', name: 'Electronics' },
    { slug: 'electronics-laptops', name: 'Laptops' },
    { slug: 'electronics-tvs', name: 'TV & Home Entertainment' },
    { slug: 'electronics-headphones', name: 'Headphones' },
    { slug: 'electronics-appliances', name: 'Home Appliances' },
    { slug: 'electronics-tablets', name: 'Tablets' },
    { slug: 'fashion', name: 'Fashion' },
    { slug: 'fashion-tops', name: 'Tops' },
    { slug: 'books', name: 'Books' },
  ],
};

const parse = (raw: string) => parseSearchQuery(raw, catalog);

// ---------------------------------------------------------------------------
// Money. Everything here is in paise: ₹15,000 is 1_500_000, never 15_000.
// ---------------------------------------------------------------------------

describe('price — upper bound', () => {
  it.each([
    ['under 15k', 1_500_000],
    ['under 15000', 1_500_000],
    ['below ₹15,000', 1_500_000],
    ['less than 15 thousand', 1_500_000],
    ['upto 15k', 1_500_000],
    ['up to 15k', 1_500_000],
    ['within 15k', 1_500_000],
    ['max 15000', 1_500_000],
    ['at most rs 15000', 1_500_000],
    ['cheaper than rs. 15,000', 1_500_000],
    ['not more than inr 15000', 1_500_000],
  ])('%s -> maxPricePaise %d', (input, expected) => {
    expect(parse(input).filters.maxPricePaise).toBe(expected);
  });

  it('₹15,000 is 1500000 paise, not 15000', () => {
    const { filters } = parse('under ₹15,000');
    expect(filters.maxPricePaise).toBe(1_500_000);
    expect(filters.maxPricePaise).not.toBe(15_000);
  });
});

describe('price — lower bound', () => {
  it.each([
    ['above 20k', 2_000_000],
    ['over 20000', 2_000_000],
    ['more than ₹20,000', 2_000_000],
    ['at least 20k', 2_000_000],
    ['minimum 20000', 2_000_000],
    ['starting from rs 20000', 2_000_000],
  ])('%s -> minPricePaise %d', (input, expected) => {
    expect(parse(input).filters.minPricePaise).toBe(expected);
  });
});

describe('price — ranges', () => {
  it.each([
    'between 10k and 20k',
    'between 10000 and 20000',
    'from 10k to 20k',
    '10k-20k',
    '10k to 20k',
    '10k – 20k',
  ])('%s -> 1000000..2000000 paise', (input) => {
    const { filters } = parse(input);
    expect(filters.minPricePaise).toBe(1_000_000);
    expect(filters.maxPricePaise).toBe(2_000_000);
  });

  it('normalises a reversed range', () => {
    const { filters } = parse('between 20k and 10k');
    expect(filters.minPricePaise).toBe(1_000_000);
    expect(filters.maxPricePaise).toBe(2_000_000);
  });

  it('leaves a model number alone', () => {
    // "12-15" is an iPhone range, not ₹12–₹15.
    const { filters, cleanedKeywords } = parse('iphone 12-15');
    expect(filters.minPricePaise).toBeUndefined();
    expect(filters.maxPricePaise).toBeUndefined();
    expect(cleanedKeywords).toContain('12-15');
  });
});

describe('price — magnitude words', () => {
  it.each([
    ['1.5 lakh', 15_000_000],
    ['1.5 lac', 15_000_000],
    ['2 lakhs', 20_000_000],
    ['1 crore', 1_000_000_000],
    ['50 thousand', 5_000_000],
  ])('under %s -> %d paise', (amount, expected) => {
    expect(parse(`under ${amount}`).filters.maxPricePaise).toBe(expected);
  });

  it('handles comma-grouped Indian numerals', () => {
    expect(parse('under ₹1,50,000').filters.maxPricePaise).toBe(15_000_000);
  });

  it('does not read a unit like 15kg as 15k', () => {
    const { filters, cleanedKeywords } = parse('rice 15kg');
    expect(filters.maxPricePaise).toBeUndefined();
    expect(cleanedKeywords).toContain('15kg');
  });
});

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

describe('intent words map to a sort and are stripped', () => {
  it.each([
    ['best laptop', 'rating'],
    ['top rated laptop', 'rating'],
    ['highest rated laptop', 'rating'],
    ['popular laptop', 'popularity'],
    ['trending laptop', 'popularity'],
    ['best selling laptop', 'popularity'],
    ['cheapest laptop', 'price_asc'],
    ['lowest price laptop', 'price_asc'],
    ['most expensive laptop', 'price_desc'],
    ['latest laptop', 'newest'],
    ['newest laptop', 'newest'],
  ])('%s -> sort %s', (input, expected) => {
    expect(parse(input).sort).toBe(expected);
  });

  it('removes the intent word from the keywords', () => {
    expect(parse('best laptop').cleanedKeywords).not.toContain('best');
  });

  it('"top rated" wins over "top", leaving no stray "rated"', () => {
    const { sort, cleanedKeywords } = parse('top rated headphones');
    expect(sort).toBe('rating');
    expect(cleanedKeywords).not.toContain('rated');
    expect(cleanedKeywords).not.toContain('top');
  });

  it('leaves the sort null when nothing was implied', () => {
    expect(parse('samsung phone').sort).toBeNull();
  });

  it('does not find "top" inside "laptop"', () => {
    expect(parse('laptop').sort).toBeNull();
  });

  it('prefers a real category named Tops over the ranking word', () => {
    const { filters } = parse('tops');
    expect(filters.inferredCategorySlug).toBe('fashion-tops');
  });
});

// ---------------------------------------------------------------------------
// Catalog matching
// ---------------------------------------------------------------------------

describe('brand and category detection', () => {
  it('finds a brand case-insensitively and strips it', () => {
    const { filters, cleanedKeywords } = parse('SAMSUNG phone');
    expect(filters.brands).toEqual(['Samsung']);
    expect(cleanedKeywords).not.toContain('samsung');
  });

  it('finds a multi-word brand', () => {
    expect(parse('casa nova plates').filters.brands).toEqual(['Casa Nova']);
  });

  it('finds a category by name', () => {
    expect(parse('books').filters.inferredCategorySlug).toBe('books');
  });

  it('maps "samsung phone" to brand + category', () => {
    const { filters } = parse('samsung phone');
    expect(filters.brands).toEqual(['Samsung']);
    expect(filters.inferredCategorySlug).toBe('mobiles');
  });

  it('ignores a category hint this deployment does not have', () => {
    const narrow = { brands: [], categories: [{ slug: 'books', name: 'Books' }] };
    expect(parseSearchQuery('phone', narrow).filters.inferredCategorySlug).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Synonyms
// ---------------------------------------------------------------------------

describe('synonyms', () => {
  it.each([
    ['phone', 'smartphone', 'mobiles'],
    ['mobile', 'smartphone', 'mobiles'],
    ['cellphone', 'smartphone', 'mobiles'],
    ['tv', 'television', 'electronics-tvs'],
    ['fridge', 'refrigerator', 'electronics-appliances'],
    ['notebook', 'laptop', 'electronics-laptops'],
    ['earbuds', 'headphone', 'electronics-headphones'],
    ['earphones', 'headphone', 'electronics-headphones'],
  ])('%s -> %s (category %s)', (input, canonical, slug) => {
    const { cleanedKeywords, filters } = parse(input);
    expect(cleanedKeywords).toBe(canonical);
    expect(filters.inferredCategorySlug).toBe(slug);
  });
});

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

describe('discount words', () => {
  it.each(['laptop on sale', 'discounted laptop', 'laptop offers', 'laptop deals'])(
    '%s sets onSale and strips the word',
    (input) => {
      const { filters, cleanedKeywords } = parse(input);
      expect(filters.onSale).toBe(true);
      expect(cleanedKeywords).toBe('laptop');
    },
  );

  it('leaves onSale unset when not asked for', () => {
    expect(parse('laptop').filters.onSale).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The whole thing, and the ordinary case
// ---------------------------------------------------------------------------

describe('full queries', () => {
  it('parses "best phone under 15k" — the query that returned nothing', () => {
    const { cleanedKeywords, filters, sort } = parse('best phone under 15k');
    expect(sort).toBe('rating');
    expect(filters.maxPricePaise).toBe(1_500_000);
    expect(filters.inferredCategorySlug).toBe('mobiles');
    expect(cleanedKeywords).toBe('smartphone');
  });

  it('parses "best phone under 15000" the same way', () => {
    const a = parse('best phone under 15k');
    const b = parse('best phone under 15000');
    expect(b).toEqual(a);
  });

  it('parses a query using every feature at once', () => {
    const { cleanedKeywords, filters, sort } = parse(
      'cheapest samsung smart tv between 20k and 50k on sale',
    );
    expect(sort).toBe('price_asc');
    expect(filters.brands).toEqual(['Samsung']);
    expect(filters.minPricePaise).toBe(2_000_000);
    expect(filters.maxPricePaise).toBe(5_000_000);
    expect(filters.onSale).toBe(true);
    expect(filters.inferredCategorySlug).toBe('electronics-tvs');
    expect(cleanedKeywords).toBe('television');
  });
});

describe('the common case: nothing to parse', () => {
  it('returns the query untouched with no filters', () => {
    const result = parse('wireless charging pad');
    expect(result.cleanedKeywords).toBe('wireless charging pad');
    expect(result.filters).toEqual({ brands: [] });
    expect(result.sort).toBeNull();
  });

  it('handles an empty string', () => {
    const result = parse('');
    expect(result.cleanedKeywords).toBe('');
    expect(result.filters).toEqual({ brands: [] });
    expect(result.sort).toBeNull();
  });

  it('handles whitespace only', () => {
    expect(parse('   ').cleanedKeywords).toBe('');
  });

  it('keeps a plain model number as keywords', () => {
    expect(parse('galaxy s24 ultra').cleanedKeywords).toBe('galaxy s24 ultra');
  });
});
