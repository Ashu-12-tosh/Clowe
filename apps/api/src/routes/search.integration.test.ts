import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { describeParsedQuery } from '@clowe/shared';
import type { ProductListResponse, SuggestResponse } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { invalidateSearchCatalog } from '../services/productSearch';
import { FIXTURE, seedFixture } from '../test/fixture';

/**
 * Search and suggestions, end to end: real Postgres, real router, real HTTP.
 *
 * Every case here is a behaviour that was wrong at some point while this was
 * being built. They are regression guards first and documentation second.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

beforeAll(async () => {
  await seedFixture(prisma);
  // The catalog cache is a module-level map; a fresh fixture must not be read
  // through a cache built from whatever was there before.
  invalidateSearchCatalog();
  server = createApp().listen(0);
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function search(query: string): Promise<ProductListResponse> {
  const res = await fetch(`${base}/api/products?${query}`);
  const json = (await res.json()) as { success: boolean; data: ProductListResponse };
  expect(json.success).toBe(true);
  return json.data;
}

async function suggest(q: string): Promise<SuggestResponse> {
  const res = await fetch(`${base}/api/search/suggest?q=${encodeURIComponent(q)}`);
  const json = (await res.json()) as { success: boolean; data: SuggestResponse };
  expect(json.success).toBe(true);
  return json.data;
}

const slugs = (body: ProductListResponse) => body.items.map((i) => i.slug);

// ---------------------------------------------------------------------------

describe('the original bug', () => {
  it('"best phone under 15k" returns products', async () => {
    const body = await search(`q=${encodeURIComponent('best phone under 15k')}`);
    // This returned zero before the parser existed — the whole string was
    // matched literally against product titles.
    expect(body.total).toBeGreaterThan(0);
    expect(slugs(body)).toContain(FIXTURE.phoneCheapInMobiles);
  });

  it('understands the query the way it was typed', async () => {
    const body = await search(`q=${encodeURIComponent('best phone under 15k')}`);
    expect(body.search?.parsed.filters.maxPricePaise).toBe(1_500_000); // paise, not rupees
    expect(body.search?.parsed.sort).toBe('rating');
    expect(body.search?.parsed.filters.inferredCategorySlug).toBe('mobiles');
  });

  it('excludes anything above the cap', async () => {
    const body = await search(`q=${encodeURIComponent('best phone under 15k')}`);
    expect(slugs(body)).not.toContain(FIXTURE.phoneExpensive); // ₹80,000
  });
});

describe('alias expansion widens the match', () => {
  it('finds a product titled "Phone" when searching "phone"', async () => {
    const body = await search('q=phone');
    // Canonicalising to a single term would miss this one: its title never
    // says "Smartphone". Expansion has to search the whole family.
    expect(slugs(body)).toContain(FIXTURE.phoneWordedPlainly);
  });

  it('finds "Smartphone" products from the same query', async () => {
    const body = await search('q=phone');
    expect(slugs(body)).toContain(FIXTURE.phoneCheapInMobiles);
  });

  it('works in the other direction too', async () => {
    const body = await search('q=smartphone');
    expect(slugs(body)).toContain(FIXTURE.phoneWordedPlainly);
  });
});

describe('an inferred category ranks but never filters', () => {
  it('keeps products from the other category tree', async () => {
    const body = await search(`q=${encodeURIComponent('phone under 15k')}`);
    // "phone" infers the Mobiles tree, but this one lives under Electronics.
    // A hard filter would hide it; the guess is only allowed to rank.
    expect(slugs(body)).toContain(FIXTURE.phoneCheapInElectronics);
    expect(slugs(body)).toContain(FIXTURE.phoneCheapInMobiles);
  });

  it('reports how many results came from outside the guess', async () => {
    const body = await search(`q=${encodeURIComponent('phone under 15k')}`);
    expect(body.search?.outsideInferredCategory).toBeGreaterThan(0);
  });

  it('ranks the guessed category first', async () => {
    const body = await search(`q=${encodeURIComponent('phone under 15k')}`);
    const order = slugs(body);
    expect(order.indexOf(FIXTURE.phoneCheapInMobiles)).toBeLessThan(
      order.indexOf(FIXTURE.phoneCheapInElectronics),
    );
  });
});

describe('an explicit category does filter', () => {
  it('narrows to the chosen tree', async () => {
    const body = await search('q=phone&category=mobiles');
    expect(slugs(body)).toContain(FIXTURE.phoneCheapInMobiles);
    expect(slugs(body)).not.toContain(FIXTURE.phoneCheapInElectronics);
  });

  it('can exclude everything the keyword matched', async () => {
    const body = await search('q=phone&category=books');
    expect(body.total).toBe(0);
  });
});

describe('relaxation', () => {
  it('drops the price bound rather than return nothing', async () => {
    const body = await search(`q=${encodeURIComponent('smartphone under 500')}`);
    expect(body.total).toBeGreaterThan(0);
    expect(body.search?.relaxed?.dropped).toContain('maxPrice');
  });

  it('never drops the keywords', async () => {
    const body = await search(`q=${encodeURIComponent('smartphone under 500')}`);
    // Discarding the search term would turn a specific query into "here is the
    // whole catalog", which reads as a broken search rather than a helpful one.
    expect(body.search?.relaxed?.dropped).not.toContain('keywords');
    for (const item of body.items) expect(item.title.toLowerCase()).toContain('phone');
    expect(slugs(body)).not.toContain(FIXTURE.book);
  });

  it('flags that it relaxed instead of doing it silently', async () => {
    const body = await search(`q=${encodeURIComponent('smartphone under 500')}`);
    expect(body.search?.relaxed).not.toBeNull();
    expect(body.search?.relaxed?.message).toMatch(/no exact match/i);
  });

  it('leaves relaxed null when the query matched as asked', async () => {
    const body = await search('q=phone');
    expect(body.search?.relaxed).toBeNull();
  });
});

describe('a query that matches nothing', () => {
  it('returns zero results, not the catalog', async () => {
    const body = await search('q=qwertyuiopasdf');
    expect(body.total).toBe(0);
    expect(body.items).toHaveLength(0);
    expect(body.search?.strategy).toBe('none');
  });
});

describe('typo tolerance', () => {
  it('reaches a real brand through a typo', async () => {
    const body = await search('q=zephry'); // Zephyr
    expect(body.total).toBeGreaterThan(0);
    expect(body.search?.strategy).toBe('trigram');
  });

  it('returns nothing for a brand that is not in the catalog', async () => {
    // "smasung" scores ~0.375 against everything here, below the 0.45 cutoff.
    // Both halves matter: the threshold has to admit real typos and reject
    // words that merely look word-shaped.
    const body = await search('q=smasung');
    expect(body.total).toBe(0);
  });
});

describe('"best" ranks on evidence, not on average alone', () => {
  it('puts a well-reviewed 4.5 above a 4.7 with three reviews', async () => {
    const body = await search('q=zephyr&sort=rating');
    const order = slugs(body);
    expect(order.indexOf(FIXTURE.ratedGoodHighCount)).toBeLessThan(
      order.indexOf(FIXTURE.ratedHighLowCount),
    );
  });

  it('ranks an unreviewed product last', async () => {
    const body = await search('q=zephyr&sort=rating');
    const order = slugs(body);
    expect(order[order.length - 1]).toBe(FIXTURE.ratedNone);
  });
});

describe('browsing without a search term is untouched', () => {
  it('returns the category and carries no search metadata', async () => {
    const body = await search('category=books');
    expect(body.total).toBeGreaterThan(0);
    expect(slugs(body)).toContain(FIXTURE.book);
    expect(body.search).toBeUndefined();
  });

  it('still builds the option facets the browse UI needs', async () => {
    const body = await search('category=books');
    expect(body.facets.options.length).toBeGreaterThan(0);
  });

  it('respects an explicit price filter, given in rupees', async () => {
    // maxPrice is rupees on the wire and paise in the database — ₹1,000 must
    // exclude the ₹2,000 tee.
    const body = await search('category=books&maxPrice=1000');
    expect(slugs(body)).toContain(FIXTURE.book); // ₹600
    expect(slugs(body)).not.toContain(FIXTURE.ratedHighLowCount); // ₹2,000
  });
});

describe('moderation applies to search and suggestions alike', () => {
  it('never returns a draft or a hidden product', async () => {
    const body = await search('q=smartphone');
    expect(slugs(body)).not.toContain(FIXTURE.hiddenDraft);
    expect(slugs(body)).not.toContain(FIXTURE.hiddenInvisible);
  });

  it('never suggests one either', async () => {
    const data = await suggest('smartphone');
    const suggested = data.products.map((p) => p.slug);
    expect(suggested).not.toContain(FIXTURE.hiddenDraft);
    expect(suggested).not.toContain(FIXTURE.hiddenInvisible);
  });

  it('every suggestion leads to a page that loads', async () => {
    const data = await suggest('z');
    for (const product of data.products) {
      const res = await fetch(`${base}/api/products/${product.slug}`);
      expect(res.status).toBe(200);
    }
  });
});

describe('suggestions', () => {
  it('matches on a prefix', async () => {
    const data = await suggest('zep');
    expect(data.products.length).toBeGreaterThan(0);
    expect(data.brands.map((b) => b.name)).toContain('Zephyr');
  });

  it('answers a single character', async () => {
    const data = await suggest('z');
    expect(data.products.length).toBeGreaterThan(0);
  });

  it('tells two same-named categories apart by their parent', async () => {
    const data = await suggest('smartphone');
    const smartphones = data.categories.filter((c) => c.name === 'Smartphones');
    expect(smartphones).toHaveLength(2);
    // Without the parent the dropdown would show the same word twice.
    const parents = smartphones.map((c) => c.parentName).sort();
    expect(parents).toEqual(['Electronics', 'Mobiles']);
  });

  it('caps every group', async () => {
    const data = await suggest('z');
    expect(data.products.length).toBeLessThanOrEqual(5);
    expect(data.categories.length).toBeLessThanOrEqual(5);
    expect(data.brands.length).toBeLessThanOrEqual(5);
    expect(data.trending.length).toBeLessThanOrEqual(5);
  });

  it('offers best sellers when nothing has been typed', async () => {
    const data = await suggest('');
    expect(data.trending.length).toBeGreaterThan(0);
    expect(data.products).toHaveLength(0);
  });

  it('returns a thumbnail and a price with each product', async () => {
    const data = await suggest('zep');
    for (const product of data.products) {
      expect(product.imageUrl).toBeTruthy();
      expect(product.pricePaise).toBeGreaterThan(0);
    }
  });

  it('echoes the query so a stale response can be discarded', async () => {
    const data = await suggest('zep');
    expect(data.q).toBe('zep');
  });
});

// ---------------------------------------------------------------------------

const chipLabels = (data: SuggestResponse) => (data.understood?.chips ?? []).map((c) => c.label);
const titles = (data: SuggestResponse) => data.products.map((p) => p.title);
const suggestedSlugs = (data: SuggestResponse) => data.products.map((p) => p.slug);

/**
 * The type-ahead runs the parser too, but sees the phrase one character at a
 * time. Two failure modes sit on either side of that, and both have happened:
 * not parsing at all, which made "best phone" return nothing here while the
 * page behind it returned phones; and parsing too eagerly, which would strip
 * the "best" out of someone three letters into typing it.
 *
 * These eight cases are the states a shopper passes through typing "best
 * phone", in order.
 */
describe('typing towards an intent word', () => {
  it('"b" is a letter, not a filter', async () => {
    const data = await suggest('b');
    expect(data.understood).toBeNull();
    expect(data.categories.map((c) => c.name)).toContain('Books');
  });

  it('"be" still matches text', async () => {
    const data = await suggest('be');
    expect(data.understood).toBeNull();
    expect(suggestedSlugs(data)).toContain(FIXTURE.partialIntentWord);
  });

  it('"bes" is still letters, and says so by finding nothing', async () => {
    const data = await suggest('bes');
    // Nothing in this catalog contains "bes". The point of the assertion is the
    // null: the word was kept as a prefix and simply did not match, rather than
    // being swallowed as a half-recognised "best".
    expect(data.understood).toBeNull();
    expect(data.products).toHaveLength(0);
  });

  it('"best" is a whole intent word, so it becomes a sort', async () => {
    const data = await suggest('best');
    expect(chipLabels(data)).toContain('Top rated');
  });

  it('"best " means the same thing as "best"', async () => {
    const withSpace = await suggest('best ');
    const without = await suggest('best');
    expect(chipLabels(withSpace)).toEqual(chipLabels(without));
    expect(suggestedSlugs(withSpace)).toEqual(suggestedSlugs(without));
  });

  it('"best p" keeps the trailing fragment as a prefix', async () => {
    const data = await suggest('best p');
    expect(chipLabels(data)).toContain('Top rated');
    // Every product shown is there because of the "p", not because of "best".
    expect(titles(data).length).toBeGreaterThan(0);
    for (const title of titles(data)) expect(title.toLowerCase()).toContain('p');
  });

  it('"best ph" narrows as more of the word arrives', async () => {
    const data = await suggest('best ph');
    expect(chipLabels(data)).toContain('Top rated');
    for (const title of titles(data)) expect(title.toLowerCase()).toContain('ph');
  });

  it('"best phone" suggests phones', async () => {
    const data = await suggest('best phone');
    expect(chipLabels(data)).toContain('Top rated');
    const slugs = suggestedSlugs(data);
    expect(slugs).toContain(FIXTURE.phoneCheapInMobiles);
    // Alias expansion, same as the results page: a product titled "Phone" and
    // one titled "Smartphone" both belong to the same query.
    expect(slugs).toContain(FIXTURE.phoneWordedPlainly);
  });
});

describe('a space is what finishes a word', () => {
  it('an unspaced trailing word stays a search term', async () => {
    const data = await suggest('phone cheap');
    expect(chipLabels(data)).not.toContain('Cheapest first');
  });

  it('the same word followed by a space becomes a sort', async () => {
    const data = await suggest('phone cheap ');
    expect(chipLabels(data)).toContain('Cheapest first');
  });
});

describe('a query that is all intent still answers', () => {
  it('"best" shows top-rated products rather than nothing', async () => {
    const data = await suggest('best');
    expect(data.products.length).toBeGreaterThan(0);
    expect(data.understood?.productsLabel).toBe('Top rated');
  });

  it('ranks them on evidence, the way the results page ranks "best"', async () => {
    const data = await suggest('best');
    const slugs = suggestedSlugs(data);
    // 4.7 from seven thousand reviews leads; 4.5 from nine thousand beats 4.7
    // from three — the same Bayesian blend the results page uses, because both
    // go through searchProducts.
    expect(slugs[0]).toBe(FIXTURE.phoneTopRatedInElectronics);
    expect(slugs.indexOf(FIXTURE.ratedGoodHighCount)).toBeLessThan(
      slugs.indexOf(FIXTURE.ratedHighLowCount),
    );
    // No reviews is an absence of evidence, not an average verdict.
    expect(slugs).not.toContain(FIXTURE.ratedNone);
  });
});

describe('a price is a filter, not a search term', () => {
  it('never prefix-matches the amount', async () => {
    const data = await suggest('phone under 15k');
    // No title contains "15k"; if the amount had reached the prefix matcher
    // this group would be empty instead of full of phones.
    expect(data.products.length).toBeGreaterThan(0);
    for (const title of titles(data)) expect(title.toLowerCase()).not.toContain('15k');
  });

  it('applies the bound it understood', async () => {
    const slugs = suggestedSlugs(await suggest('phone under 15k'));
    expect(slugs).toContain(FIXTURE.phoneCheapInMobiles);
    expect(slugs).toContain(FIXTURE.phoneCheapInElectronics);
    expect(slugs).not.toContain(FIXTURE.phoneExpensive);
  });

  it('does not offer headphones to someone searching for phones', async () => {
    const slugs = suggestedSlugs(await suggest('phone under 15k'));
    // "phone" is a substring of "Headphones" but not a word in it, and this one
    // is cheap enough that the price bound cannot be what excludes it.
    expect(slugs).not.toContain(FIXTURE.headphoneNotAPhone);
    expect(slugs).toContain(FIXTURE.phoneCheapInMobiles);
  });

  it('says what it understood, so the amount does not just vanish', async () => {
    const labels = chipLabels(await suggest('phone under 15k'));
    expect(labels).toContain('Under ₹15,000');
    expect(labels).toContain('Mobiles');
  });

  it('keeps showing products while the amount is half-typed', async () => {
    // "phone under 1" is a real keystroke on the way to "15k", and a ₹1 cap
    // matches nothing. Flashing "Nothing matches" mid-word is the behaviour
    // this endpoint exists to avoid.
    const data = await suggest('phone under 1');
    expect(chipLabels(data)).toContain('Under ₹1');
    expect(data.products.length).toBeGreaterThan(0);
  });
});

describe('the dropdown and the results page agree', () => {
  it('extracts the same filters from the same phrase', async () => {
    const phrase = 'best phone under 15k';
    const page = await search('q=' + encodeURIComponent(phrase));
    const data = await suggest(phrase);
    // Both sides render their chips with describeParsedQuery, so a difference
    // here means the two endpoints parsed the phrase differently.
    const fromPage = describeParsedQuery(page.search!.parsed, { categoryName: 'Mobiles' });
    expect(chipLabels(data)).toEqual(fromPage.map((c) => c.label));
  });

  it('suggests only products the same search would return', async () => {
    const phrase = 'phone under 15k';
    const page = await search('q=' + encodeURIComponent(phrase) + '&limit=48');
    const fromPage = new Set(slugs(page));
    for (const slug of suggestedSlugs(await suggest(phrase))) {
      expect(fromPage.has(slug)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * The sort a search is in. It used to be displayed and not applied: "best
 * phone" showed a Top rated chip over results in relevance order, and even a
 * sort picked from the dropdown only broke ties inside the category boost, so
 * "cheapest first" put the cheapest phone behind every phone in the guessed
 * tree. These pin the order itself, not just what the page says about it.
 */
describe('the parsed sort is applied, not just displayed', () => {
  it('"best phone" is in rating order, across both smartphone trees', async () => {
    const body = await search(`q=${encodeURIComponent('best phone')}`);
    // Best rated, and filed in the tree "phone" does not infer. A sort that
    // only broke ties inside the boost would have put it fourth.
    expect(slugs(body)[0]).toBe(FIXTURE.phoneTopRatedInElectronics);
    expect(body.search?.appliedSort).toBe('rating');
    expect(body.search?.sortSource).toBe('parsed');
  });

  it('"cheapest phone" is in price order from the first result to the last', async () => {
    const body = await search(`q=${encodeURIComponent('cheapest phone')}`);
    const prices = body.items.map((item) => item.pricePaise);
    expect(prices.length).toBeGreaterThan(2);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(body.search?.appliedSort).toBe('price_asc');
  });

  it('a search with no sort in its words is in relevance order, and says so', async () => {
    const body = await search(`q=${encodeURIComponent('phone')}`);
    expect(body.search?.appliedSort).toBeNull();
    expect(body.search?.sortSource).toBe('relevance');
    // Relevance still ranks the guessed category first.
    const first = body.items[0]?.slug;
    expect([FIXTURE.phoneCheapInMobiles, FIXTURE.phoneWordedPlainly, FIXTURE.phoneExpensive]).toContain(first);
  });

  it('removing the sort chip goes back to relevance', async () => {
    const body = await search(`q=${encodeURIComponent('best phone')}&drop=sort`);
    expect(body.search?.appliedSort).toBeNull();
    expect(body.search?.sortSource).toBe('relevance');
    expect(slugs(body)[0]).not.toBe(FIXTURE.phoneTopRatedInElectronics);
  });
});

describe('a sort picked from the dropdown beats the one in the words', () => {
  it('"best phone" sorted cheapest-first is cheapest-first', async () => {
    const body = await search(`q=${encodeURIComponent('best phone')}&sort=price_asc`);
    const prices = body.items.map((item) => item.pricePaise);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(body.search?.appliedSort).toBe('price_asc');
    expect(body.search?.sortSource).toBe('chosen');
  });

  it('still reports what the words implied, so the page can explain the override', async () => {
    const body = await search(`q=${encodeURIComponent('best phone')}&sort=price_asc`);
    expect(body.search?.parsed.sort).toBe('rating');
  });

  it('a picked sort orders across both trees too, not just within the guessed one', async () => {
    const body = await search(`q=${encodeURIComponent('phone')}&sort=rating`);
    expect(slugs(body)[0]).toBe(FIXTURE.phoneTopRatedInElectronics);
    expect(body.search?.sortSource).toBe('chosen');
  });

  it('picking the listing default still counts as picking it', async () => {
    const body = await search(`q=${encodeURIComponent('best phone')}&sort=newest`);
    expect(body.search?.appliedSort).toBe('newest');
    expect(body.search?.sortSource).toBe('chosen');
  });
});

// ---------------------------------------------------------------------------

/**
 * A category name that is the whole topic of a query.
 *
 * Parsing turns an exact category name into a guess that only ranks. With no
 * words left to search, ranking alone narrowed nothing: "bedding" returned the
 * entire catalog. The name is now matched two ways — as every category of that
 * name, and as words through the synonym map — and either is enough. The guess
 * of which category was meant still only ranks.
 */
describe('a category name that is the whole query narrows to it', () => {
  const PHONES = [
    FIXTURE.phoneCheapInMobiles,
    FIXTURE.phoneWordedPlainly,
    FIXTURE.phoneExpensive,
    FIXTURE.phoneCheapInElectronics,
    FIXTURE.phoneTopRatedInElectronics,
  ];
  const IN_MOBILES = [FIXTURE.phoneCheapInMobiles, FIXTURE.phoneWordedPlainly, FIXTURE.phoneExpensive];
  const IN_ELECTRONICS = [FIXTURE.phoneCheapInElectronics, FIXTURE.phoneTopRatedInElectronics];
  const q = (text: string) => `q=${encodeURIComponent(text)}&limit=48`;

  it('returns that category, not the catalog', async () => {
    const body = await search(q('smartphones'));
    expect(body.search?.strategy).toBe('category');
    // Both categories named Smartphones, and nothing else.
    expect(slugs(body).sort()).toEqual([...PHONES].sort());
  });

  it('returns nothing for an empty category, instead of everything', async () => {
    const body = await search(q('bedding'));
    expect(body.total).toBe(0);
  });

  it('"mobiles" returns every phone across both trees', async () => {
    // The case that ruled out filtering on the category alone: Mobiles holds
    // only some of the phones, and the rest are filed under Electronics. Read
    // as words too, "mobiles" is a word for phones, and finds them all.
    const body = await search(q('mobiles'));
    for (const phone of PHONES) expect(slugs(body)).toContain(phone);
    expect(slugs(body)).not.toContain(FIXTURE.hiddenDraft);
    expect(slugs(body)).not.toContain(FIXTURE.hiddenInvisible);
  });

  it('ranks what matched both ways above what matched one way', async () => {
    const order = slugs(await search(q('mobiles')));
    const lastBothWays = Math.max(...IN_MOBILES.map((s) => order.indexOf(s)));
    const firstOneWay = Math.min(...IN_ELECTRONICS.map((s) => order.indexOf(s)));
    expect(lastBothWays).toBeLessThan(firstOneWay);
  });

  it('ranks a product that only mentions the name in its description below the category', async () => {
    // Everything filed under Books, then the belt whose description says "book
    // bag". The words half is where noise comes from; it has to stay below.
    const order = slugs(await search(q('books')));
    expect(order).toContain(FIXTURE.book);
    expect(order[order.length - 1]).toBe(FIXTURE.partialIntentWord);
  });

  it('counts the other tree as outside "Mobiles", and both Smartphones as inside', async () => {
    expect((await search(q('mobiles'))).search?.outsideInferredCategory).toBe(IN_ELECTRONICS.length);
    expect((await search(q('smartphones'))).search?.outsideInferredCategory).toBe(0);
  });

  it('"smartphones under 15k" narrows instead of returning everything under ₹15k', async () => {
    const body = await search(q('smartphones under 15k'));
    expect(slugs(body).sort()).toEqual(
      [FIXTURE.phoneCheapInMobiles, FIXTURE.phoneWordedPlainly, FIXTURE.phoneCheapInElectronics].sort(),
    );
    // All under ₹15k, and none of them a smartphone.
    for (const other of [FIXTURE.book, FIXTURE.partialIntentWord, FIXTURE.headphoneNotAPhone]) {
      expect(slugs(body)).not.toContain(other);
    }
  });

  it('"zephyr smartphones" does not return Zephyr jackets', async () => {
    const body = await search(q('zephyr smartphones'));
    expect(slugs(body).sort()).toEqual([FIXTURE.phoneCheapInMobiles, FIXTURE.phoneExpensive].sort());
    expect(slugs(body)).not.toContain(FIXTURE.ratedNone); // the jacket
    expect(slugs(body)).not.toContain(FIXTURE.ratedGoodHighCount); // the shirt
  });

  it('price relaxation drops the price, never the category', async () => {
    // The ₹600 book is the only thing under ₹1,000. Loosening the category
    // would have returned it; loosening the price returns smartphones.
    const body = await search(q('smartphones under 1k'));
    expect(body.search?.relaxed?.dropped).toEqual(['maxPrice']);
    expect(slugs(body)).not.toContain(FIXTURE.book);
    expect(slugs(body).sort()).toEqual([...PHONES].sort());
  });

  it('an applied sort still leads', async () => {
    // Top rated is filed under Electronics, so for "mobiles" it matched one way
    // only (its title) and relevance would put it after the Mobiles phones.
    const body = await search(q('best mobiles'));
    expect(slugs(body)[0]).toBe(FIXTURE.phoneTopRatedInElectronics);
    expect(body.search?.appliedSort).toBe('rating');
  });

  it('"phone" still goes down the keyword path, unchanged', async () => {
    // Not a category name: parsing leaves the keyword "smartphone", so the
    // guessed category only ranks, exactly as before.
    const body = await search(q('phone'));
    expect(body.search?.strategy).toBe('fts');
    expect(body.search?.parsed.cleanedKeywords).toBe('smartphone');
    expect(body.search?.parsed.filters.inferredCategorySlug).toBe('mobiles');
    expect(slugs(body).sort()).toEqual([...PHONES].sort());
    expect(body.search?.outsideInferredCategory).toBe(IN_ELECTRONICS.length);
    // Relevance: the guessed tree first.
    expect(IN_MOBILES).toContain(slugs(body)[0]);
  });
});