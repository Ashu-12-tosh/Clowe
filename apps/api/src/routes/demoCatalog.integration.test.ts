import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { invalidateCategoryRules } from '../services/categoryRules';
import { invalidateSearchCatalog } from '../services/productSearch';
import { setSetting } from '../services/settingsService';
import { bustHomeCache } from './home';
import { signAccessToken } from '../utils/jwt';

/**
 * The demo catalog behind demoCatalogEnabled (off by default), and stock
 * photos kept off every shopper-facing answer while it is off.
 *
 * Off: the demo store and everything it sells reach no shopper — listing,
 * search, dropdown, home, product and store pages, cart — and no shopper
 * answer carries a picsum or loremflickr URL, whatever row it comes from
 * (home banners, promo tiles, category images and banners). A home link into
 * a department with nothing to buy is left out. On: all of it comes back.
 * Rows are never touched; the seller's own screens are left as they are.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

const DEMO = { slug: 'demo-stock-photo-tee', title: 'Demo Stock Photo Tee' };
const STOCK = /picsum\.photos|loremflickr\.com/;

let adminToken: string;
let shopperToken: string;
let demoSellerToken: string;
let demoVariantId: string;

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { data?: unknown } };
}
const get = (path: string, token: string | null = null) => call('GET', path, token);

async function setDemo(open: boolean) {
  const res = await call('PUT', '/api/admin/settings', adminToken, { demoCatalogEnabled: open });
  expect(res.status).toBe(200);
  expect((res.json.data as { demoCatalogEnabled: boolean }).demoCatalogEnabled).toBe(open);
}

beforeAll(async () => {
  await seedFixture(prisma);
  await setSetting('demoCatalogEnabled', false);

  // A department only the demo store sells in, with a stock photo and banner.
  const demoDept = await prisma.category.create({
    data: { slug: 'demo-dept', name: 'Demo Dept', icon: '🧪', imageUrl: 'https://picsum.photos/seed/cat/400/400' },
  });
  await prisma.categoryBanner.create({
    data: {
      categoryId: demoDept.id,
      headline: 'Demo Dept Days',
      imageUrl: 'https://picsum.photos/seed/category-banner/1200/600',
      primaryLabel: 'Shop',
      primaryHref: '/products?category=demo-dept',
    },
  });
  // The fixture's books are a real seller's: a books tile stays.
  await prisma.category.update({ where: { slug: 'books' }, data: { imageUrl: 'https://loremflickr.com/400/400/books' } });

  const demoUser = await prisma.user.create({
    data: { phone: '9198000001', name: 'Demo Owner', role: Role.SELLER, referralCode: 'DEMO-S' },
  });
  const demoSeller = await prisma.sellerProfile.create({
    data: { userId: demoUser.id, shopName: 'Clowe Demo Store', slug: 'demo-store-test', status: SellerStatus.APPROVED, isDemo: true },
  });
  demoSellerToken = signAccessToken({ sub: demoUser.id, role: 'SELLER' });
  const product = await prisma.product.create({
    data: {
      sellerId: demoSeller.id,
      categoryId: demoDept.id,
      title: DEMO.title,
      slug: DEMO.slug,
      description: 'A seeded demo listing.',
      basePricePaise: 49_900,
      soldCount: 10_000, // a best seller: it would lead every rail if shown
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
    },
  });
  await prisma.productImage.create({ data: { productId: product.id, url: 'https://picsum.photos/seed/tee/600/800', sortOrder: 0 } });
  demoVariantId = (
    await prisma.productVariant.create({
      data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-DEMO-TEE', pricePaise: 49_900, stock: 10 },
    })
  ).id;

  await prisma.homeBanner.deleteMany();
  await prisma.promoTile.deleteMany();
  await prisma.homeBanner.create({
    data: { headline: 'Shop Everything.', highlight: 'Everything.', imageUrl: 'https://picsum.photos/seed/hero/1000/750', primaryLabel: 'Shop now', primaryHref: '/products' },
  });
  await prisma.promoTile.createMany({
    data: [
      { placement: 'PROMO_CARD', title: 'Books Festival', subtitle: 'Up to 50% Off', href: '/products?category=books', imageUrl: 'https://picsum.photos/seed/promo-books/600/400' },
      { placement: 'PROMO_CARD', title: 'Demo Dept Sale', subtitle: 'Up to 60% Off', href: '/products?category=demo-dept', imageUrl: 'https://picsum.photos/seed/promo-demo/600/400' },
    ],
  });

  const admin = await prisma.user.create({ data: { phone: '9198000002', name: 'Demo Admin', role: Role.ADMIN, referralCode: 'DEMO-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const shopper = await prisma.user.create({ data: { phone: '9198000003', name: 'Demo Shopper', referralCode: 'DEMO-C' } });
  shopperToken = signAccessToken({ sub: shopper.id, role: 'CUSTOMER' });
  const cart = await prisma.cart.create({ data: { userId: shopper.id } });
  await prisma.cartItem.create({ data: { cartId: cart.id, variantId: demoVariantId, quantity: 1 } });

  invalidateCategoryRules();
  invalidateSearchCatalog();
  bustHomeCache();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await setSetting('demoCatalogEnabled', false);
  await prisma.homeBanner.deleteMany();
  await prisma.promoTile.deleteMany();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

const SHOPPER_READS: Array<[string, boolean?]> = [
  ['/api/home'],
  ['/api/categories'],
  ['/api/categories/demo-dept'],
  ['/api/categories/books'],
  ['/api/products?limit=48'],
  ['/api/products?q=tee'],
  ['/api/search/suggest?q=demo'],
  ['/api/search/suggest?q='],
  ['/api/cart', true],
];

describe('while the demo catalog is off (the default)', () => {
  it.each(SHOPPER_READS)('%s carries neither the demo product nor any stock photo', async (path, authed) => {
    const res = await get(path, authed ? shopperToken : null);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(DEMO.slug);
    expect(res.text).not.toMatch(STOCK);
  });

  it('the demo product and the demo store are 404s', async () => {
    expect((await get(`/api/products/${DEMO.slug}`)).status).toBe(404);
    expect((await get('/api/stores/demo-store-test')).status).toBe(404);
    expect((await get('/api/stores/demo-store-test/products')).status).toBe(404);
    // A real store is untouched.
    expect((await get('/api/stores/fixture-store')).status).toBe(200);
  });

  it('nothing from it can be put in a cart', async () => {
    expect((await call('POST', '/api/cart/items', shopperToken, { variantId: demoVariantId, quantity: 1 })).status).toBe(404);
  });

  it('home keeps its banner with no image yet, keeps the books tile, and drops the tile into an empty department', async () => {
    const home = (await get('/api/home')).json.data as {
      banners: { headline: string; imageUrl: string | null }[];
      promoCards: { href: string; imageUrl: string | null }[];
      categories: { slug: string; imageUrl: string | null }[];
    };
    expect(home.banners).toEqual([expect.objectContaining({ headline: 'Shop Everything.', imageUrl: null })]);
    expect(home.promoCards.map((c) => c.href)).toEqual(['/products?category=books']);
    expect(home.promoCards[0]!.imageUrl).toBeNull();
    expect(home.categories.find((c) => c.slug === 'books')?.imageUrl).toBeNull();
  });

  it('touches no row: product, image, banner, tile and category keep their stock photos in the database', async () => {
    expect(await prisma.productImage.count({ where: { url: { contains: 'picsum.photos' } } })).toBe(1);
    expect(await prisma.homeBanner.count({ where: { imageUrl: { contains: 'picsum.photos' } } })).toBe(1);
    expect(await prisma.promoTile.count({ where: { imageUrl: { contains: 'picsum.photos' } } })).toBe(2);
    expect((await prisma.category.findUniqueOrThrow({ where: { slug: 'books' } })).imageUrl).toContain('loremflickr.com');
    expect(await prisma.cartItem.count({ where: { variantId: demoVariantId } })).toBe(1);
  });

  it("leaves the demo seller's own screens as they are", async () => {
    const own = await get('/api/seller/products', demoSellerToken);
    expect(own.status).toBe(200);
    expect(own.text).toContain(DEMO.slug);
  });
});

describe('once the admin turns the demo catalog on', () => {
  beforeAll(() => setDemo(true));

  it('the demo product is back in the listing, search, home and its store', async () => {
    expect((await get('/api/products?limit=48')).text).toContain(DEMO.slug);
    expect((await get('/api/products?q=tee')).text).toContain(DEMO.slug);
    expect((await get('/api/search/suggest?q=demo')).text).toContain(DEMO.slug);
    expect((await get('/api/home')).text).toContain(DEMO.slug);
    expect((await get(`/api/products/${DEMO.slug}`)).status).toBe(200);
    expect((await get('/api/stores/demo-store-test/products')).text).toContain(DEMO.slug);
    expect((await get('/api/cart', shopperToken)).text).toContain(DEMO.title);
  });

  it('the stock photos and the demo department tile come back with it', async () => {
    const home = (await get('/api/home')).text;
    expect(home).toMatch(STOCK);
    expect(home).toContain('/products?category=demo-dept');
    expect((await get('/api/categories/demo-dept')).text).toMatch(STOCK);
  });

  it('turning it off again hides everything at once', async () => {
    await setDemo(false);
    for (const [path, authed] of SHOPPER_READS) {
      const text = (await get(path, authed ? shopperToken : null)).text;
      expect(text).not.toContain(DEMO.slug);
      expect(text).not.toMatch(STOCK);
    }
  });
});
