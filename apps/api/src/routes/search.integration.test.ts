import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
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
