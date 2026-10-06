import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { invalidateCategoryRules } from '../services/categoryRules';
import { invalidateSearchCatalog } from '../services/productSearch';
import { setSetting } from '../services/settingsService';
import { bustHomeCache } from './home';
import { signAccessToken } from '../utils/jwt';

/**
 * Grocery and Supplements behind foodCategoriesEnabled (off until FSSAI).
 *
 * Off: nothing in or under them reaches a shopper — the category tree, the
 * category and product pages, the listing, search and its dropdown, the home
 * page (rails, tiles, links into them), a store page, the cart — and sellers
 * cannot list anything new there. On: every one of those shows it again. The
 * rows themselves are never touched.
 *
 * Each response is checked as text for the food slugs and titles, so the test
 * does not depend on where in the payload a thing would have appeared.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

const RICE = { slug: 'fssai-basmati-rice', title: 'FSSAI Basmati Rice' };
const WHEY = { slug: 'fssai-whey-protein', title: 'FSSAI Whey Protein' };
const FOOD_CATEGORY_SLUGS = ['grocery', 'grocery-staples', 'grocery-staples-rice', 'supplements', 'supplements-protein'];

let adminToken: string;
let sellerToken: string;
let shopperToken: string;
let packingVideoRef: string;
let riceVariantId: string;
let ids: { staples: string; books: string };

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { data?: unknown; error?: { code: string } } };
}

const get = (path: string, token: string | null = null) => call('GET', path, token);

/** Names that must not appear in a shopper-facing answer while food is closed. */
const FOOD_MARKERS = [RICE.slug, RICE.title, WHEY.slug, WHEY.title, ...FOOD_CATEGORY_SLUGS.map((s) => `"${s}"`)];
const showsFood = (text: string) => FOOD_MARKERS.filter((m) => text.includes(m));

async function setFood(open: boolean) {
  const res = await call('PUT', '/api/admin/settings', adminToken, { foodCategoriesEnabled: open });
  expect(res.status).toBe(200);
  expect((res.json.data as { foodCategoriesEnabled: boolean }).foodCategoriesEnabled).toBe(open);
}

function draft(categoryId: string, title: string) {
  return {
    mode: 'DRAFT',
    title,
    categoryId,
    description: 'A listing that exists to test the food category switch.',
    imageUrls: ['https://example.com/food.jpg'],
    packingVideoRef,
    weightGrams: 500,
    lengthMm: 200,
    widthMm: 100,
    heightMm: 50,
    variants: [{ optionValues: {}, sellerPricePaise: 20_000, stock: 5 }],
  };
}

beforeAll(async () => {
  await seedFixture(prisma);
  await setSetting('foodCategoriesEnabled', false);

  const category = (slug: string, name: string, parentId: string | null) =>
    prisma.category.create({ data: { slug, name, parentId } });
  const grocery = await category('grocery', 'Grocery', null);
  const staples = await category('grocery-staples', 'Staples', grocery.id);
  // A third level: hidden at any depth, not just the roots' direct children.
  const rice = await category('grocery-staples-rice', 'Rice', staples.id);
  const supplements = await category('supplements', 'Supplements', null);
  const protein = await category('supplements-protein', 'Protein', supplements.id);
  const books = await prisma.category.findUniqueOrThrow({ where: { slug: 'books' } });
  ids = { staples: staples.id, books: books.id };

  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  sellerToken = signAccessToken({ sub: seller.userId, role: 'SELLER' });
  const clip = await prisma.asset.create({
    data: { provider: 'local', key: 'test/packing-video/food.mp4', purpose: 'PACKING_VIDEO', contentType: 'video/mp4', bytes: 1, ownerId: seller.userId },
  });
  packingVideoRef = `asset:${clip.id}`;

  const product = async (p: { slug: string; title: string }, categoryId: string) => {
    const created = await prisma.product.create({
      data: {
        sellerId: seller.id,
        categoryId,
        title: p.title,
        slug: p.slug,
        description: `${p.title}, filed under a food category.`,
        basePricePaise: 30_000,
        // Best sellers, so they would lead every rail and the dropdown if shown.
        soldCount: 10_000,
        status: ProductStatus.APPROVED,
        approvedAt: new Date(),
      },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: created.id, optionValues: {}, optionsKey: '', label: '', sku: `SKU-${p.slug}`, pricePaise: 30_000, stock: 10 },
    });
    return variant.id;
  };
  riceVariantId = await product(RICE, rice.id);
  await product(WHEY, protein.id);

  await prisma.promoTile.deleteMany();
  await prisma.promoTile.create({
    data: { placement: 'PROMO_STRIP', title: 'Genuine Supplements', href: '/products?category=supplements' },
  });

  const admin = await prisma.user.create({ data: { phone: '9196000001', name: 'Food Admin', role: Role.ADMIN, referralCode: 'FOOD-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const shopper = await prisma.user.create({ data: { phone: '9196000002', name: 'Food Shopper', referralCode: 'FOOD-C' } });
  shopperToken = signAccessToken({ sub: shopper.id, role: 'CUSTOMER' });
  // Put in the cart and the wishlist while food was open, as a real cart would have been.
  const cart = await prisma.cart.create({ data: { userId: shopper.id } });
  await prisma.cartItem.create({ data: { cartId: cart.id, variantId: riceVariantId, quantity: 1 } });

  // Rows created behind the caches' backs.
  invalidateCategoryRules();
  invalidateSearchCatalog();
  bustHomeCache();

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await setSetting('foodCategoriesEnabled', false);
  await prisma.promoTile.deleteMany();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** Every shopper-facing read that could surface a food category or product. */
const SHOPPER_READS: Array<[string, string, boolean?]> = [
  ['category tree (navigation, filters, seller picker)', '/api/categories'],
  ['listing', '/api/products?limit=48'],
  ['search results', '/api/products?q=rice'],
  ['search results', '/api/products?q=protein'],
  ['search dropdown', '/api/search/suggest?q=rice'],
  ['search dropdown', '/api/search/suggest?q=protein'],
  ['search dropdown, empty', '/api/search/suggest?q='],
  ['home page', '/api/home'],
  ['store page', '/api/stores/fixture-store/products'],
  ['cart', '/api/cart', true],
];

describe('while the food categories are closed (the default)', () => {
  it.each(SHOPPER_READS)('%s (%s) shows nothing from them', async (_label, path, authed) => {
    const res = await get(path, authed ? shopperToken : null);
    expect(res.status).toBe(200);
    expect(showsFood(res.text)).toEqual([]);
  });

  it.each(['grocery', 'grocery-staples', 'grocery-staples-rice', 'supplements', 'supplements-protein'])(
    'category page %s is a 404, at any depth',
    async (slug) => {
      expect((await get(`/api/categories/${slug}`)).status).toBe(404);
      expect((await get(`/api/products?category=${slug}`)).status).toBe(404);
    },
  );

  it('their product pages are 404s', async () => {
    expect((await get(`/api/products/${RICE.slug}`)).status).toBe(404);
    expect((await get(`/api/products/${WHEY.slug}`)).status).toBe(404);
  });

  it('nothing from them can be added to the cart', async () => {
    const res = await call('POST', '/api/cart/items', shopperToken, { variantId: riceVariantId, quantity: 1 });
    expect(res.status).toBe(404);
  });

  it('sellers cannot list anything new in them, and can elsewhere', async () => {
    const closed = await call('POST', '/api/seller/products', sellerToken, draft(ids.staples, 'New Toor Dal'));
    expect(closed.status).toBe(400);
    expect(closed.json.error?.code).toBe('CATEGORY_CLOSED');

    const open = await call('POST', '/api/seller/products', sellerToken, draft(ids.books, 'A New Novel'));
    expect(open.status).toBe(200);
  });

  it('leaves every row untouched: categories, products and the cart line', async () => {
    expect(await prisma.category.count({ where: { slug: { in: FOOD_CATEGORY_SLUGS } } })).toBe(5);
    const products = await prisma.product.findMany({ where: { slug: { in: [RICE.slug, WHEY.slug] } } });
    expect(products.map((p) => [p.status, p.isVisible])).toEqual([
      [ProductStatus.APPROVED, true],
      [ProductStatus.APPROVED, true],
    ]);
    expect(await prisma.cartItem.count({ where: { variantId: riceVariantId } })).toBe(1);
  });
});

describe('once the admin opens them', () => {
  beforeAll(() => setFood(true));

  it.each(SHOPPER_READS.filter(([, path]) => path !== '/api/search/suggest?q='))(
    '%s (%s) shows them again',
    async (_label, path, authed) => {
      const res = await get(path, authed ? shopperToken : null);
      expect(res.status).toBe(200);
      expect(showsFood(res.text).length).toBeGreaterThan(0);
    },
  );

  it('the home page brings back the categories, the products and the promo that links there', async () => {
    const res = await get('/api/home');
    for (const marker of ['"grocery"', '"supplements"', RICE.slug, '/products?category=supplements']) {
      expect(res.text).toContain(marker);
    }
  });

  it('category pages, deep ones included, and product pages answer again', async () => {
    for (const slug of FOOD_CATEGORY_SLUGS) expect((await get(`/api/categories/${slug}`)).status).toBe(200);
    expect((await get('/api/products?category=grocery')).text).toContain(RICE.slug);
    expect((await get(`/api/products/${RICE.slug}`)).status).toBe(200);
    expect((await get(`/api/products/${WHEY.slug}`)).status).toBe(200);
  });

  it('the cart line that waited comes back, and adding works', async () => {
    expect((await get('/api/cart', shopperToken)).text).toContain(RICE.title);
    expect((await call('POST', '/api/cart/items', shopperToken, { variantId: riceVariantId, quantity: 1 })).status).toBe(200);
  });

  it('sellers can list in them again', async () => {
    const res = await call('POST', '/api/seller/products', sellerToken, draft(ids.staples, 'New Toor Dal'));
    expect(res.status).toBe(200);
  });

  it('closing them again hides everything at once — no cache waits it out', async () => {
    await get('/api/home');
    await get('/api/search/suggest?q=rice');
    await setFood(false);
    expect(showsFood((await get('/api/home')).text)).toEqual([]);
    expect(showsFood((await get('/api/search/suggest?q=rice')).text)).toEqual([]);
    expect(showsFood((await get('/api/categories')).text)).toEqual([]);
  });
});
