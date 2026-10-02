import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminCategoryFacets } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { invalidateCategoryRules } from '../services/categoryRules';
import { FACET_SEED, seedCategoryFacets } from '../../prisma/seed/facets';

/**
 * Facet definitions are data on the category tree: inherited down it, edited
 * by admins, and seeded only where nobody has set any.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
const id: Record<string, string> = {};

beforeAll(async () => {
  await seedFixture(prisma);
  for (const c of await prisma.category.findMany({ select: { id: true, slug: true } })) id[c.slug] = c.id;
  const admin = await prisma.user.create({ data: { phone: '9190000000', name: 'Facet Admin', role: Role.ADMIN, referralCode: 'FCT-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/admin/category-facets${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: AdminCategoryFacets; error?: { message: string } } };
}

describe('the seed', () => {
  it('fills only categories with no facets of their own, and reports the rest', async () => {
    await prisma.category.update({
      where: { id: id['mobiles'] },
      data: { facets: { add: [{ key: 'warranty_years', label: 'Warranty', kind: 'list' }], hide: [] } },
    });
    const report = await seedCategoryFacets(prisma, true);
    invalidateCategoryRules();
    expect(report.kept).toEqual(['mobiles']);
    expect(report.written).toEqual(expect.arrayContaining(['electronics', 'books', 'electronics-smartphones', 'mobiles-smartphones']));
    // The fixture's Bedding is a root here, not under Home & Kitchen; the seed knows it only by slug.
    expect(report.inheriting).toEqual(['bedding']);
    expect(report.unknownSlugs).toContain('electronics-laptops');
    // The admin's edit survived.
    const mobiles = await prisma.category.findUniqueOrThrow({ where: { id: id['mobiles'] } });
    expect(mobiles.facets).toEqual({ add: [{ key: 'warranty_years', label: 'Warranty', kind: 'list' }], hide: [] });
    const books = await prisma.category.findUniqueOrThrow({ where: { id: id['books'] } });
    expect(books.facets).toEqual(FACET_SEED.books);
  });
});

describe('the admin facets API', () => {
  it('shows what a category inherits, what shoppers see, and what each child ends up with', async () => {
    const { status, json } = await call('GET', `/${id['electronics']}`);
    expect(status).toBe(200);
    expect(json.data.inherited).toEqual([]);
    expect(json.data.resolved.map((f) => f.key)).toEqual(['color']);
    const phones = json.data.children.find((c) => c.slug === 'electronics-smartphones')!;
    expect(phones.hasOwn).toBe(true);
    expect(phones.facets.map((f) => f.key)).toEqual(['ram', 'storage', 'screen_size', 'network', 'processor', 'color']);

    const child = await call('GET', `/${id['electronics-smartphones']}`);
    expect(child.json.data.inherited.map((f) => [f.key, f.fromCategoryName])).toEqual([['color', 'Electronics']]);
    expect(child.json.data.category.path.map((p) => p.name)).toEqual(['Electronics', 'Smartphones']);
  });

  it('saves an edit, and the children see it at once', async () => {
    const saved = await call('PUT', `/${id['electronics']}`, {
      config: {
        add: [
          { key: 'color', label: 'Colour', kind: 'color' },
          { key: 'warranty_years', label: 'Warranty', kind: 'list', values: ['1 year', '2 years'] },
        ],
        hide: [],
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.data.resolved.map((f) => f.key)).toEqual(['color', 'warranty_years']);
    const phones = saved.json.data.children.find((c) => c.slug === 'electronics-smartphones')!;
    expect(phones.facets.map((f) => f.key)).toContain('warranty_years');

    // A child hides one inherited facet and moves another to the front.
    const child = await call('PUT', `/${id['electronics-smartphones']}`, {
      config: { add: [], hide: ['warranty_years'], order: ['color'] },
    });
    expect(child.json.data.resolved.map((f) => f.key)).toEqual(['color']);
  });

  it('refuses a key that is on every rail already, and saves nothing', async () => {
    const before = await prisma.category.findUniqueOrThrow({ where: { id: id['books'] } });
    const res = await call('PUT', `/${id['books']}`, { config: { add: [{ key: 'brand', label: 'Brand' }], hide: [] } });
    expect(res.status).toBe(400);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: id['books'] } })).facets).toEqual(before.facets);
  });

  it('clears a category back to "exactly as the parent"', async () => {
    const res = await call('PUT', `/${id['electronics-smartphones']}`, { config: null });
    expect(res.json.data.own).toBeNull();
    expect(res.json.data.resolved.map((f) => f.key)).toEqual(['color', 'warranty_years']);
  });

  it('is for admins only', async () => {
    const shopper = await prisma.user.create({ data: { phone: '9190000001', name: 'Shopper', referralCode: 'FCT-U' } });
    const res = await fetch(`${base}/api/admin/category-facets/${id['books']}`, {
      headers: { authorization: `Bearer ${signAccessToken({ sub: shopper.id, role: 'CUSTOMER' })}` },
    });
    expect(res.status).toBe(403);
  });
});
