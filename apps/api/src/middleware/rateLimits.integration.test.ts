import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { corsOrigins } from '../env';
import { CATALOG_READ_LIMIT, GLOBAL_LIMIT, TOO_MANY_REQUESTS, isCatalogRead } from './rateLimits';

let server: Server;
let base: string;
const ORIGIN = corsOrigins[0]!;

beforeAll(() => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Behind nginx, "trust proxy 1" takes the client address from the last
// X-Forwarded-For hop — each test is its own shopper.
const from = (ip: string, init: RequestInit = {}) => ({
  ...init,
  headers: { origin: ORIGIN, 'x-forwarded-for': ip, ...(init.headers as Record<string, string> | undefined) },
});

async function burst(n: number, path: string, ip: string, init?: RequestInit) {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 50) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(50, n - i) }, () => fetch(`${base}${path}`, from(ip, init)).then((r) => r.status)),
    );
    statuses.push(...batch);
  }
  return statuses;
}

describe('rate limits', () => {
  it('a 429 carries the same CORS headers as any other reply, and says what happened', async () => {
    const ip = '203.0.113.10';
    const statuses = await burst(GLOBAL_LIMIT, '/api/me', ip);
    expect(statuses).not.toContain(429);

    const refused = await fetch(`${base}/api/me`, from(ip));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(refused.headers.get('access-control-allow-credentials')).toBe('true');
    const json = (await refused.json()) as { error: { code: string; message: string } };
    expect(json.error).toEqual({ code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS });
  });

  it('public catalog reads have their own, higher allowance than everything else', async () => {
    expect(CATALOG_READ_LIMIT).toBeGreaterThan(GLOBAL_LIMIT);
    const ip = '203.0.113.20';
    // Past the general limit on catalog pages alone: still served.
    const reads = await burst(GLOBAL_LIMIT + 50, '/api/home', ip);
    expect(reads.filter((s) => s === 429)).toHaveLength(0);
    // ...and browsing has not used up the allowance for anything else.
    expect((await fetch(`${base}/api/me`, from(ip))).status).toBe(401);
  });

  it('counts only GETs on home, categories, products and search as catalog reads', () => {
    for (const path of ['/home', '/categories', '/categories/fashion', '/products', '/products/some-slug', '/search', '/search/suggest']) {
      expect(isCatalogRead({ method: 'GET', path })).toBe(true);
    }
    expect(isCatalogRead({ method: 'POST', path: '/products/x/reviews' })).toBe(false);
    for (const path of ['/me', '/orders', '/productsx', '/seller/products', '/auth/otp/request']) {
      expect(isCatalogRead({ method: 'GET', path })).toBe(false);
    }
  });
});
