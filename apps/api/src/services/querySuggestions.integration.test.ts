import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import {
  normalizeSuggestInput,
  type ProductListResponse,
  type SuggestResponse,
} from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { FIXTURE, seedFixture } from '../test/fixture';
import { LIVE_PRODUCT_WHERE, invalidateSearchCatalog } from './productSearch';
import {
  MIN_LOGGED_SEARCHES,
  querySuggestionSnapshot,
  refreshQuerySuggestions,
  verifyPhrase,
  type QuerySuggestionSnapshot,
} from './querySuggestions';

/**
 * Query suggestions, end to end: built from the fixture catalog, then checked
 * against the real results page over real HTTP.
 *
 * The headline test is the first one. Every phrase the generator keeps is run
 * back through /api/products, independently of the generator's own
 * bookkeeping, and has to come back non-empty, unrelaxed, and with the count
 * it was built with. A suggestion that dead-ends is the original zero-results
 * bug, and this is what stops it coming back as a suggestion.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let built: QuerySuggestionSnapshot;
let liveCount: number;

beforeAll(async () => {
  await seedFixture(prisma);
  invalidateSearchCatalog();
  // Nothing logged, so every phrase below is one the generator built.
  await prisma.searchQuery.deleteMany();
  built = await refreshQuerySuggestions();
  liveCount = await prisma.product.count({ where: LIVE_PRODUCT_WHERE });

  server = createApp().listen(0);
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function search(q: string): Promise<ProductListResponse> {
  const res = await fetch(`${base}/api/products?q=${encodeURIComponent(q)}&limit=1`);
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

const texts = (data: SuggestResponse) => data.queries.map((q) => q.text);
const phraseOf = (text: string) => querySuggestionSnapshot()?.phrases.find((p) => p.text === text);

// ---------------------------------------------------------------------------

describe('every suggested phrase leads somewhere', () => {
  it('builds a real set from the fixture, not an empty one that passes vacuously', () => {
    expect(built.phrases.length).toBeGreaterThan(10);
  });

  it('returns results on the results page — as many as when it was checked', async () => {
    const failures: string[] = [];
    for (const phrase of built.phrases) {
      const page = await search(phrase.text);
      const meta = page.search;
      const ok =
        page.total > 0 &&
        page.total === phrase.total &&
        meta?.relaxed === null &&
        meta?.strategy !== 'trigram';
      if (!ok) {
        failures.push(
          `"${phrase.text}": total ${page.total} (built with ${phrase.total}), ` +
            `strategy ${meta?.strategy}, relaxed ${meta?.relaxed ? 'yes' : 'no'}`,
        );
      }
    }
    // Listed rather than stopping at the first, so one run shows every dead end.
    expect(failures).toEqual([]);
  });

  it('narrows the catalog — no phrase opens every product', () => {
    for (const phrase of built.phrases) expect(phrase.total).toBeLessThan(liveCount);
  });
});

describe('phrases that would only look meaningful are rejected', () => {
  it('an exact category name, which reorders the whole catalog and filters nothing', async () => {
    // The results page reads "smartphones" as a category guess that ranks and
    // never filters, and returns everything. Non-empty, and meaningless.
    expect(await verifyPhrase('smartphones', liveCount)).toEqual({ ok: false, reason: 'no-narrowing' });
    for (const name of ['smartphones', 'mobiles', 'electronics', 'books']) {
      expect(phraseOf(name)).toBeUndefined();
    }
  });

  it('a bound nothing sits under', async () => {
    // The cheapest phone here is ₹3,000. The results page answers this by
    // dropping the bound, which is honest there and a lie as a suggestion.
    const outcome = await verifyPhrase('phone under 1k', liveCount);
    expect(outcome.ok).toBe(false);
    expect(phraseOf('phone under 1k')).toBeUndefined();
  });

  it('a word found only through typo tolerance', async () => {
    expect(await verifyPhrase('smartphnoe', liveCount)).toEqual({ ok: false, reason: 'typo' });
  });

  it('a thing named only in descriptions — no washing machines from a care label', async () => {
    // The tee's description says "machine wash". Full-text search matches it,
    // so the phrase is non-empty, narrow and matched as written, and still
    // there are no washing machines here.
    const outcome = await verifyPhrase('washing machine', liveCount);
    expect(outcome.ok).toBe(true); // the results page does find something...
    expect(phraseOf('washing machine')).toBeUndefined(); // ...and it is not suggested.
    expect(built.phrases.some((p) => p.text.includes('washing machine'))).toBe(false);
    expect(built.phrases.some((p) => p.text.includes('washer'))).toBe(false);
  });
});

describe('price bounds come from the prices in the catalog', () => {
  it('offers only bounds some phone actually sits under', () => {
    // Live phones here cost ₹3,000, ₹12,000, ₹13,000 and ₹80,000. The quartiles
    // land on ₹3,000 and ₹12,000, the second rounded up to how people say it.
    const bounds = built.phrases
      .filter((p) => p.text.startsWith('phone under '))
      .map((p) => p.text)
      .sort();
    expect(bounds).toEqual(['phone under 15k', 'phone under 3k']);
  });

  it('never offers a bound below the cheapest phone', () => {
    const tooLow = built.phrases.filter((p) =>
      /\bphone under (?:\d{3}|[12]k)$/.test(p.text),
    );
    expect(tooLow).toEqual([]);
  });
});

describe('the dropdown', () => {
  const PREFIXES = ['b', 'be', 'bes', 'best', 'best p', 'best phone', 'phone under', 'cheap'];

  it.each(PREFIXES)('"%s": every query suggestion completes what was typed', async (typed) => {
    const data = await suggest(typed);
    const prefix = normalizeSuggestInput(typed);
    for (const text of texts(data)) {
      expect(text.startsWith(prefix)).toBe(true);
      // What was typed is one Enter away; offering it back is noise.
      expect(text).not.toBe(prefix.trim());
    }
  });

  it('"be" still returns the belt — partial typing is untouched', async () => {
    const data = await suggest('be');
    expect(data.products.map((p) => p.slug)).toContain(FIXTURE.partialIntentWord);
  });

  it('"bes" completes to searches instead of finding nothing', async () => {
    const data = await suggest('bes');
    expect(texts(data).length).toBeGreaterThan(0);
    for (const text of texts(data)) expect(text.startsWith('bes')).toBe(true);
  });

  it('"best" offers different searches, not one search worded six ways', async () => {
    const data = await suggest('best');
    const phrases = texts(data).map(phraseOf);
    const resultKeys = phrases.map((p) => p?.resultKey);
    expect(new Set(resultKeys).size).toBe(resultKeys.length);
  });

  it('"phone under" completes to a price the catalog supports', async () => {
    const data = await suggest('phone under');
    expect(texts(data)).toEqual(expect.arrayContaining(['phone under 3k', 'phone under 15k']));
  });

  it('"cheap" completes to cheapest-first searches', async () => {
    const data = await suggest('cheap');
    expect(texts(data).some((t) => t.startsWith('cheapest '))).toBe(true);
  });

  it('keeps the chips that explain the parse', async () => {
    const data = await suggest('best');
    expect(data.understood?.chips.map((c) => c.label)).toContain('Top rated');
  });

  it('shows searches from a prebuilt set — nothing is generated per keystroke', async () => {
    const before = querySuggestionSnapshot();
    for (const typed of ['p', 'ph', 'pho', 'phon', 'phone']) await suggest(typed);
    expect(querySuggestionSnapshot()).toBe(before);
  });
});

// Last: this block rewrites the search log and rebuilds the set.
describe('logged searches', () => {
  beforeAll(async () => {
    await prisma.searchQuery.deleteMany();
    const logged = (normalized: string, times: number, strategy = 'fts') =>
      Array.from({ length: times }, () => ({
        query: normalized,
        normalized,
        resultCount: 1,
        strategy,
        relaxed: false,
      }));
    await prisma.searchQuery.createMany({
      data: [
        ...logged('zephyr lite', MIN_LOGGED_SEARCHES),
        ...logged('vertex v30', MIN_LOGGED_SEARCHES - 1),
        // Found something when it was searched; the catalog has nothing for it now.
        ...logged('zephyr hovercraft', 5),
        ...logged('zephry', 5, 'trigram'),
      ],
    });
    await refreshQuerySuggestions();
  });

  it('rank above every phrase built from the catalog', async () => {
    const data = await suggest('zep');
    expect(data.queries[0]).toEqual({ text: 'zephyr lite', source: 'logged' });
    // Built phrases are still there underneath.
    expect(data.queries.some((q) => q.source === 'catalog')).toBe(true);
  });

  it('are not shown to anyone until they have been searched often enough', () => {
    expect(phraseOf('vertex v30')).toBeUndefined();
  });

  it('are dropped once they stop returning results', () => {
    expect(phraseOf('zephyr hovercraft')).toBeUndefined();
  });

  it('are never typos, however often they were typed', () => {
    expect(phraseOf('zephry')).toBeUndefined();
  });
});
