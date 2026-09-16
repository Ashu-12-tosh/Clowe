import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import type { ProductListResponse } from '@clowe/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { prisma as appPrisma } from '../db';
import { invalidateSearchCatalog } from './productSearch';
import { SEARCH_LOG_RETENTION_DAYS, normalizeQuery, sweepExpiredSearchLogs } from './searchAnalytics';
import { FIXTURE, seedFixture } from '../test/fixture';

/**
 * Search logging.
 *
 * The behaviours that matter are the negative ones: a log row must never hold
 * anything identifying, and a logging failure must never reach the shopper.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

beforeAll(async () => {
  await seedFixture(prisma);
  invalidateSearchCatalog();
  server = createApp().listen(0);
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

// Cleared BEFORE each test, not after: the other integration file runs its own
// searches through the same app and they land in this table too. Clearing up
// front makes every assertion here independent of which file ran first.
beforeEach(async () => {
  await prisma.searchQuery.deleteMany();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function search(query: string): Promise<ProductListResponse> {
  const res = await fetch(`${base}/api/products?q=${encodeURIComponent(query)}`);
  const json = (await res.json()) as { success: boolean; data: ProductListResponse };
  expect(json.success).toBe(true);
  return json.data;
}

/** Logging is fire-and-forget, so the row lands just after the response. */
async function waitForRows(expected: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await prisma.searchQuery.count();
    if (count >= expected || Date.now() > deadline) return count;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------

describe('what gets logged', () => {
  it('records a results-page search', async () => {
    await search('phone');
    expect(await waitForRows(1)).toBe(1);

    const row = await prisma.searchQuery.findFirstOrThrow();
    expect(row.query).toBe('phone');
    expect(row.normalized).toBe('phone');
    expect(row.resultCount).toBeGreaterThan(0);
    expect(row.strategy).toBe('fts');
    expect(row.relaxed).toBe(false);
  });

  it('records a zero-result search — the reason this table exists', async () => {
    await search('qwertyuiopasdf');
    expect(await waitForRows(1)).toBe(1);

    const row = await prisma.searchQuery.findFirstOrThrow();
    expect(row.resultCount).toBe(0);
    expect(row.strategy).toBe('none');
  });

  it('records that a search had to be loosened', async () => {
    await search('smartphone under 500');
    expect(await waitForRows(1)).toBe(1);
    expect((await prisma.searchQuery.findFirstOrThrow()).relaxed).toBe(true);
  });

  it('keeps the parsed filters, in paise', async () => {
    await search('best phone under 15k');
    expect(await waitForRows(1)).toBe(1);

    const row = await prisma.searchQuery.findFirstOrThrow();
    const parsed = row.parsedFilters as Record<string, unknown>;
    expect(parsed.maxPricePaise).toBe(1_500_000);
    expect(parsed.sort).toBe('rating');
    expect(parsed.inferredCategorySlug).toBe('mobiles');
  });

  it('groups spellings of the same search together', async () => {
    await search('  Best   Phone  ');
    expect(await waitForRows(1)).toBe(1);
    expect((await prisma.searchQuery.findFirstOrThrow()).normalized).toBe('best phone');
  });

  it('normalizeQuery collapses case and whitespace', () => {
    expect(normalizeQuery('  Best   Phone ')).toBe('best phone');
  });
});

describe('what does NOT get logged', () => {
  it('stores nothing that identifies a person', async () => {
    await search('phone');
    expect(await waitForRows(1)).toBe(1);

    const row = await prisma.searchQuery.findFirstOrThrow();
    const columns = Object.keys(row);
    // A row must not be traceable to anyone. Asserted as an absence of columns
    // rather than as null values, so adding one later fails this test loudly.
    for (const forbidden of ['userId', 'ip', 'ipAddress', 'sessionId', 'userAgent', 'deviceId']) {
      expect(columns).not.toContain(forbidden);
    }
    expect(columns.sort()).toEqual(
      ['createdAt', 'id', 'normalized', 'parsedFilters', 'query', 'relaxed', 'resultCount', 'strategy'].sort(),
    );
  });

  it('ignores suggest-endpoint keystrokes', async () => {
    // One results-page search would be one row. Typing five characters into the
    // suggest box must add none, or the table fills with prefixes.
    for (const prefix of ['z', 'ze', 'zep', 'zeph', 'zephy']) {
      await fetch(`${base}/api/search/suggest?q=${prefix}`);
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(await prisma.searchQuery.count()).toBe(0);
  });

  it('ignores a browse with no search term', async () => {
    await fetch(`${base}/api/products?category=books`);
    await new Promise((r) => setTimeout(r, 400));
    expect(await prisma.searchQuery.count()).toBe(0);
  });
});

describe('logging never costs the shopper a search', () => {
  it('answers normally when the log write fails', async () => {
    // The app's own client is what the route uses, so this is the real path.
    const create = vi
      .spyOn(appPrisma.searchQuery, 'create')
      .mockRejectedValue(new Error('search log is on fire'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const body = await search('phone');

    // The search still worked, in full.
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.map((i) => i.slug)).toContain(FIXTURE.phoneWordedPlainly);
    expect(body.search?.strategy).toBe('fts');

    await new Promise((r) => setTimeout(r, 300));
    expect(create).toHaveBeenCalled();
    // The failure was swallowed and reported, not thrown.
    expect(consoleError).toHaveBeenCalled();
    expect(await prisma.searchQuery.count()).toBe(0);
  });

  it('does not reject the request when the write is merely slow', async () => {
    vi.spyOn(appPrisma.searchQuery, 'create').mockImplementation(
      () => new Promise(() => {}) as never, // never settles
    );
    const started = Date.now();
    const body = await search('phone');
    // The response must not wait on the write. A generous bound: the point is
    // that it returned at all, not how fast — CI timings are not assertable.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(body.total).toBeGreaterThan(0);
  });
});

describe('retention', () => {
  it('deletes rows past the window and keeps the rest', async () => {
    const old = new Date(Date.now() - (SEARCH_LOG_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    await prisma.searchQuery.create({
      data: { query: 'ancient', normalized: 'ancient', resultCount: 0, strategy: 'none', createdAt: old },
    });
    await prisma.searchQuery.create({
      data: { query: 'recent', normalized: 'recent', resultCount: 3, strategy: 'fts' },
    });

    expect(await sweepExpiredSearchLogs()).toBe(1);
    const left = await prisma.searchQuery.findMany({ select: { query: true } });
    expect(left.map((r) => r.query)).toEqual(['recent']);
  });
});

describe('the admin view', () => {
  it('needs an admin', async () => {
    const res = await fetch(`${base}/api/admin/search/analytics`);
    expect(res.status).toBe(401);
  });

  it('ranks failed searches by how often they happened', async () => {
    await search('qwertyuiopasdf');
    await search('qwertyuiopasdf');
    await search('zzzzzzzzzznope');
    await waitForRows(3);

    // Query the grouping the endpoint uses, without needing an admin session.
    const groups = await prisma.searchQuery.groupBy({
      by: ['normalized'],
      where: { resultCount: 0 },
      _count: { _all: true },
      orderBy: { _count: { normalized: 'desc' } },
    });
    expect(groups[0].normalized).toBe('qwertyuiopasdf');
    expect(groups[0]._count._all).toBe(2);
  });
});
