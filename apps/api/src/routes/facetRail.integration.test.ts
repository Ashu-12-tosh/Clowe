import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProductListResponse, RailFacet } from '@clowe/shared';
import { createApp } from '../app';
import { FIXTURE, seedFixture } from '../test/fixture';
import { invalidateCategoryRules } from '../services/categoryRules';

/**
 * The filter rail: facets that fit what was found, counts that leave a
 * facet's own choice out, and filters that hold for one variant at a time.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let sellerId: string;
let n = 0;

async function category(slug: string, parentSlug: string | null, facets: object | null) {
  const parent = parentSlug ? await prisma.category.findUniqueOrThrow({ where: { slug: parentSlug } }) : null;
  return prisma.category.create({
    data: { name: slug.replace(/^.*-/, '').replace(/^./, (c) => c.toUpperCase()), slug, parentId: parent?.id ?? null, ...(facets ? { facets } : {}) },
  });
}

type V = { options: Record<string, string>; price: number; stock?: number; mrp?: number };
async function product(categorySlug: string, title: string, brand: string, variants: V[], attributes: object[] = []) {
  n += 1;
  const cat = await prisma.category.findUniqueOrThrow({ where: { slug: categorySlug } });
  const p = await prisma.product.create({
    data: {
      sellerId,
      categoryId: cat.id,
      title,
      slug: `rail-${n}`,
      description: `${title} for the rail tests.`,
      brand,
      basePricePaise: variants[0].price * 100,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
      attributes,
    },
  });
  let i = 0;
  for (const v of variants) {
    i += 1;
    await prisma.productVariant.create({
      data: {
        productId: p.id,
        optionValues: v.options,
        optionsKey: `${n}-${i}`,
        sku: `RAIL-${n}-${i}`,
        pricePaise: v.price * 100,
        mrpPaise: v.mrp ? v.mrp * 100 : null,
        stock: v.stock ?? 5,
      },
    });
  }
  return p;
}

const attr = (key: string, value: string) => ({ key, label: key, value });

beforeAll(async () => {
  await seedFixture(prisma);
  sellerId = (await prisma.sellerProfile.findFirstOrThrow()).id;
  // Everything under one root, so a listing of it is a mix the fixture's own products stay out of.
  await category('mix', null, null);
  await category('apparel', 'mix', {
    add: [
      { key: 'size', label: 'Size', kind: 'size' },
      { key: 'color', label: 'Colour', kind: 'color' },
      { key: 'sleeve', label: 'Sleeve', kind: 'list', values: ['Half sleeve', 'Full sleeve'] },
    ],
    hide: [],
  });
  await category('apparel-shirts', 'apparel', { add: [{ key: 'fabric', label: 'Fabric', kind: 'list' }], hide: [] });
  await category('tv', 'mix', { add: [{ key: 'screen_size', label: 'Screen size', kind: 'size', alsoKeys: ['size', 'screen'] }], hide: [] });
  await category('gadgets', 'mix', null);

  await product('apparel-shirts', 'Alpha Oxford Shirt', 'Alpha', [
    { options: { size: 'M', color: 'Navy', color_family: 'Blue' }, price: 900, mrp: 1800 },
    { options: { size: 'L', color: 'Navy', color_family: 'Blue' }, price: 1500 },
  ], [attr('sleeve', 'Half sleeve'), attr('fabric', 'Cotton')]);
  await product('apparel-shirts', 'Beta Linen Shirt', 'Beta', [
    { options: { size: 'M', color: 'Black', color_family: 'Black' }, price: 1500 },
    { options: { size: 'XL', color: 'Black', color_family: 'Black' }, price: 800 },
  ], [attr('sleeve', 'full sleeve'), attr('fabric', 'Linen')]);
  await product('apparel-shirts', 'Alpha Sky Shirt', 'Alpha', [
    { options: { size: 'S', color: 'Sky Blue', color_family: 'Blue' }, price: 700, stock: 0 },
  ], [attr('sleeve', 'hlaf'), attr('fabric', 'Cotton')]);
  await product('tv', 'Gamma 55 TV', 'Gamma', [{ options: { size: '55 inch' }, price: 40000 }, { options: { size: '43 inch' }, price: 30000 }]);
  await product('tv', 'Gamma 65 TV', 'Gamma', [{ options: { screen: '65 inch' }, price: 60000 }]);
  await product('gadgets', 'Delta Camera', 'Delta', [{ options: { kit: 'Body only' }, price: 20000 }, { options: { kit: 'With lens' }, price: 25000 }]);
  await product('gadgets', 'Delta Camera Mini', 'Delta', [{ options: { kit: 'Body only' }, price: 15000 }]);
  invalidateCategoryRules();

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function list(query: string): Promise<ProductListResponse> {
  const res = await fetch(`${base}/api/products?${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ProductListResponse }).data;
}
const facet = (body: ProductListResponse, key: string): RailFacet | undefined => body.rail.facets.find((f) => f.key === key);
const values = (f: RailFacet | undefined) => f?.values.map((v) => `${v.value}:${v.count}${v.selected ? '*' : ''}`);
const titles = (body: ProductListResponse) => body.items.map((i) => i.title).sort();

describe('a category listing', () => {
  it("shows the category's facets with counts, sizes by scale and colours by family", async () => {
    const body = await list('category=apparel');
    expect(body.rail.basis).toEqual({ kind: 'category', categoryName: 'Apparel' });
    expect(values(facet(body, 'size'))).toEqual(['S:1', 'M:2', 'L:1', 'XL:1']);
    const colour = facet(body, 'color')!;
    expect(colour.values.map((v) => [v.value, v.count, v.members])).toEqual([
      ['Black', 1, ['Black']],
      ['Blue', 2, ['Navy', 'Sky Blue']],
    ]);
    // The child's own facet shows too: every product here is a shirt.
    expect(values(facet(body, 'fabric'))).toEqual(['Cotton:2', 'Linen:1']);
  });

  it('lists known values in their order, whatever the case, and keeps a one-off typo off the rail', async () => {
    const body = await list('category=apparel');
    expect(values(facet(body, 'sleeve'))).toEqual(['Half sleeve:1', 'Full sleeve:1']);
  });

  it('reads a facet under every key the category names for it', async () => {
    const body = await list('category=tv');
    expect(values(facet(body, 'screen_size'))).toEqual(['43 inch:1', '55 inch:1', '65 inch:1']);
  });

  it('offers the option axes of a category with no facets of its own', async () => {
    const body = await list('category=gadgets');
    expect(facet(body, 'kit')).toMatchObject({ label: 'Kit' });
    expect(values(facet(body, 'kit'))).toEqual(['Body only:2', 'With lens:1']);
  });
});

describe('filtering', () => {
  it('holds a size and a price on the same variant', async () => {
    // Beta has an M (₹1,500) and something under ₹1,000 (the XL) — but no M under ₹1,000.
    const body = await list('category=apparel&f[size]=M&maxPrice=1000');
    expect(titles(body)).toEqual(['Alpha Oxford Shirt']);
    expect(body.rail.applied.map((c) => c.label)).toEqual(['Size: M', 'Under ₹1,000']);
  });

  it("leaves a facet's own choice out of its counts", async () => {
    const body = await list('category=apparel&brands=Alpha');
    expect(titles(body)).toEqual(['Alpha Oxford Shirt', 'Alpha Sky Shirt']);
    expect(values(facet(body, 'brand'))).toEqual(['Alpha:2*', 'Beta:1']);
    // Other facets count within Alpha; fabric, all Cotton now, has nothing left to choose.
    expect(values(facet(body, 'size'))).toEqual(['S:1', 'M:1', 'L:1']);
    expect(facet(body, 'fabric')).toBeUndefined();
  });

  it('never counts a TV screen as a clothing size', async () => {
    const all = await list('category=mix&limit=48');
    expect(facet(all, 'size')?.values.map((v) => v.value) ?? []).not.toContain('55 inch');
    const m = await list('category=mix&f[size]=M&limit=48');
    expect(titles(m)).toEqual(['Alpha Oxford Shirt', 'Beta Linen Shirt']);
  });

  it('reads an old colour link as its family', async () => {
    const body = await list('category=apparel&colors=Navy');
    expect(titles(body)).toEqual(['Alpha Oxford Shirt', 'Alpha Sky Shirt']);
    expect(body.rail.applied.map((c) => c.label)).toEqual(['Colour: Blue']);
  });

  it('keeps a chosen value listed when nothing has it, so it can be taken off', async () => {
    const body = await list('category=apparel&f[size]=XXL');
    expect(body.total).toBe(0);
    expect(values(facet(body, 'size'))).toContain('XXL:0*');
  });

  it('filters on stock, discount and rating', async () => {
    expect(titles(await list('category=apparel&inStock=1'))).toEqual(['Alpha Oxford Shirt', 'Beta Linen Shirt']);
    expect(titles(await list('category=apparel&discount=40'))).toEqual(['Alpha Oxford Shirt']);
    const stock = facet(await list('category=apparel'), 'inStock')!;
    expect(stock.values).toEqual([{ value: '1', label: 'In stock only', count: 2, selected: false }]);
  });
});

describe('a search', () => {
  it('takes its facets from the category the words suggest, without filtering by it', async () => {
    const body = await list('q=phone');
    expect(body.rail.basis.kind).toBe('inferred');
    const slugs = body.items.map((i) => i.slug);
    expect(slugs).toContain(FIXTURE.phoneCheapInMobiles);
    expect(slugs).toContain(FIXTURE.phoneCheapInElectronics);
  });

  it('shows a mix only the facets enough of the results share', async () => {
    // Three shirts, two TVs, two cameras: size covers 3/7 of it, screen size 2/7, kit 2/7.
    const body = await list('category=mix&limit=48');
    expect(body.rail.basis).toEqual({ kind: 'category', categoryName: 'Mix' });
    const keys = body.rail.facets.map((f) => f.key);
    expect(keys).toContain('size');
    expect(keys).not.toContain('screen_size');
    expect(keys).not.toContain('kit');
  });
});
