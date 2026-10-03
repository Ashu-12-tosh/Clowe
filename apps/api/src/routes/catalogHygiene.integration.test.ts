import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CategoryNode, ProductListResponse, SuggestResponse } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { invalidateCategoryRules } from '../services/categoryRules';
import { invalidateSearchCatalog } from '../services/productSearch';

/**
 * What the filter rail would otherwise expose: brands with nothing live
 * behind them, free-text spec values, and a spec row that says less than the
 * variants do.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let sellerToken: string;
let sellerId: string;
let categoryId: string;
let n = 0;

async function call<T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, data: ((await res.json()) as { data: T }).data };
}

async function listing(opts: { brand: string; brandId?: string; status?: ProductStatus; category?: string; attributes?: object[]; options?: Record<string, string>[] }) {
  n += 1;
  const p = await prisma.product.create({
    data: {
      sellerId,
      categoryId: opts.category ?? categoryId,
      title: `Hygiene ${n}`,
      slug: `hygiene-${n}`,
      description: 'Hygiene test listing.',
      brand: opts.brand,
      brandId: opts.brandId ?? null,
      basePricePaise: 100_000,
      status: opts.status ?? ProductStatus.APPROVED,
      approvedAt: new Date(),
      attributes: opts.attributes ?? [],
    },
  });
  let i = 0;
  for (const optionValues of opts.options ?? [{}]) {
    i += 1;
    await prisma.productVariant.create({
      data: { productId: p.id, optionValues, optionsKey: `${n}-${i}`, sku: `HYG-${n}-${i}`, pricePaise: 100_000, stock: 4 },
    });
  }
  return p;
}

beforeAll(async () => {
  await seedFixture(prisma);
  const user = await prisma.user.create({ data: { phone: '9170000001', name: 'Hygiene Seller', role: Role.SELLER, referralCode: 'HYG-S' } });
  sellerId = (await prisma.sellerProfile.create({ data: { userId: user.id, shopName: 'Hygiene Shop', status: SellerStatus.APPROVED, approvedAt: new Date() } })).id;
  sellerToken = signAccessToken({ sub: user.id, role: 'SELLER' });
  categoryId = (
    await prisma.category.create({
      data: {
        name: 'Hygiene Wear',
        slug: 'hygiene-wear',
        variantAxes: [{ key: 'ram', label: 'RAM' }],
        attributeSchema: [{ key: 'sleeve', label: 'Sleeve', type: 'text' }],
        facets: {
          add: [
            { key: 'sleeve', label: 'Sleeve', kind: 'list', values: ['Half sleeve', 'Full sleeve'] },
            { key: 'fabric', label: 'Fabric', kind: 'list' },
            { key: 'color', label: 'Colour', kind: 'color' },
            { key: 'ram', label: 'RAM', kind: 'list' },
            { key: 'screen_size', label: 'Screen size', kind: 'size', alsoKeys: ['size'] },
          ],
          hide: [],
        },
      },
    })
  ).id;

  const tshirt = await prisma.brand.create({ data: { name: 'T Shirt', slug: 't-shirt' } });
  const livewear = await prisma.brand.create({ data: { name: 'Livewear', slug: 'livewear' } });
  await prisma.brand.create({ data: { name: 'Fresh Label', slug: 'fresh-label' } });
  await listing({ brand: 't shirt', brandId: tshirt.id, status: ProductStatus.DRAFT });
  await listing({ brand: 'Livewear', brandId: livewear.id });
  // A spec row saying 55 inch beside variants in 43 and 65: the variants are what is for sale.
  await listing({
    brand: 'Livewear',
    brandId: livewear.id,
    attributes: [{ key: 'screen_size', label: 'Screen size', value: '55 inch' }],
    options: [{ size: '43 inch' }, { size: '65 inch' }],
  });
  invalidateCategoryRules();
  invalidateSearchCatalog();

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('brands', () => {
  it('shows shoppers only brands with something live to buy', async () => {
    const tee = await call<SuggestResponse>('/api/search/suggest?q=t%20shirt');
    expect(tee.data.brands.map((b) => b.name)).not.toContain('T Shirt');
    const live = await call<SuggestResponse>('/api/search/suggest?q=livewear');
    expect(live.data.brands.map((b) => b.name)).toContain('Livewear');
    const fresh = await call<SuggestResponse>('/api/search/suggest?q=fresh');
    expect(fresh.data.brands.map((b) => b.name)).not.toContain('Fresh Label');

    const home = await call<{ brands: { name: string }[] }>('/api/home');
    const names = home.data.brands.map((b) => b.name);
    expect(names).toContain('Livewear');
    expect(names).not.toContain('T Shirt');
    expect(names).not.toContain('Fresh Label');
  });

  it("offers a seller live brands and an admin's new ones, never one with only drafts behind it", async () => {
    const all = await call<{ name: string }[]>('/api/seller/brands', { token: sellerToken });
    const names = all.data.map((b) => b.name);
    expect(names).toEqual(expect.arrayContaining(['Livewear', 'Fresh Label']));
    expect(names).not.toContain('T Shirt');
    const typed = await call<{ name: string }[]>('/api/seller/brands?q=live', { token: sellerToken });
    expect(typed.data.map((b) => b.name)).toEqual(['Livewear']);
  });

  it('links a typed name to the brand it matches, in that brand’s spelling', async () => {
    const res = await call<{ id: string }>('/api/seller/products', {
      method: 'POST',
      token: sellerToken,
      body: {
        title: 'Linked Brand Listing',
        categoryId,
        brand: 'livewear',
        description: 'A listing whose brand was typed in lower case.',
        imageUrls: ['/uploads/demo/a.jpg'],
        variants: [{ optionValues: {}, sellerPricePaise: 50_000, stock: 2 }],
        mode: 'DRAFT',
      },
    });
    expect(res.status).toBe(200);
    const saved = await prisma.product.findUniqueOrThrow({ where: { id: res.data.id } });
    const brand = await prisma.brand.findUniqueOrThrow({ where: { slug: 'livewear' } });
    expect(saved).toMatchObject({ brand: 'Livewear', brandId: brand.id });
  });
});

describe('the spec sheet a seller fills in', () => {
  it("offers the facets' values as dropdowns, and adds the facets' own fields", async () => {
    const tree = await call<CategoryNode[]>('/api/categories');
    const node = tree.data.find((c) => c.slug === 'hygiene-wear')!;
    expect(node.specFields).toEqual([
      { key: 'sleeve', label: 'Sleeve', type: 'select', options: ['Half sleeve', 'Full sleeve'] },
      { key: 'fabric', label: 'Fabric', type: 'text' },
      { key: 'screen_size', label: 'Screen size', type: 'text' },
    ]);
    // Colour and the RAM axis are set per variant, not on the sheet.
    expect(node.rules.attributeSchema).toEqual([{ key: 'sleeve', label: 'Sleeve', type: 'text' }]);
  });
});

describe('a spec row beside variants that carry the same thing', () => {
  it('reads the variants, not the row', async () => {
    const body = (await call<ProductListResponse>('/api/products?category=hygiene-wear')).data;
    const screen = body.rail.facets.find((f) => f.key === 'screen_size')!;
    expect(screen.values.map((v) => v.value)).toEqual(['43 inch', '65 inch']);
  });
});
