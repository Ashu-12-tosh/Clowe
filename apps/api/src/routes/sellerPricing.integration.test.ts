import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { buyerPriceFor, sellerPriceFromBuyer } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS } from '../services/settingsService';
import { invalidateCategoryRules } from '../services/categoryRules';
import { ensureSellerPrices } from '../services/sellerPricing';
import { signAccessToken } from '../utils/jwt';

/**
 * Sellers enter prices BEFORE GST; the buyer pays them plus GST at the
 * category's rate. The buyer price is what every shopper-facing read uses,
 * and a listing priced before this change keeps its buyer price to the paisa.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let seq = 0;

const GST = {
  meritPercent: DEFAULT_SETTINGS.gstMeritPercent,
  standardPercent: DEFAULT_SETTINGS.gstStandardPercent,
  valueSlabThresholdPaise: DEFAULT_SETTINGS.gstValueSlabThresholdPaise,
};

beforeAll(async () => {
  await seedFixture(prisma);
  const admin = await prisma.user.create({ data: { phone: '9180000000', name: 'Price Admin', role: Role.ADMIN, referralCode: 'PRICE-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data?: never; error?: { code: string; message: string } } };
}

/** A fresh category of its own, so GST rule changes stay inside the test. */
async function category(rules: { taxRule?: 'VALUE_SLAB' | null; defaultTaxRatePercent?: number | null } = {}) {
  seq += 1;
  const c = await prisma.category.create({
    data: { name: `Priced ${seq}`, slug: `priced-${seq}`, isActive: true, taxRule: rules.taxRule ?? null, defaultTaxRatePercent: rules.defaultTaxRatePercent ?? null },
  });
  invalidateCategoryRules();
  return c.id;
}

async function seller() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `91810${String(seq).padStart(5, '0')}`, name: `Price Seller ${seq}`, role: Role.SELLER, referralCode: `PRICE-S-${seq}` },
  });
  const profile = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Price Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  return { sellerId: profile.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

const body = (categoryId: string, variants: unknown[], extra: Record<string, unknown> = {}) => ({
  title: 'Priced Product',
  categoryId,
  description: 'A product that exists to test prices before GST.',
  imageUrls: ['/uploads/demo/a.jpg'],
  variants,
  weightGrams: 350,
  lengthMm: 300,
  widthMm: 200,
  heightMm: 50,
  mode: 'SUBMIT',
  ...extra,
});

/** A live listing priced the old way: a GST-inclusive price and no seller price. */
async function legacyListing(sellerId: string, categoryId: string, buyerPaise: number) {
  seq += 1;
  const product = await prisma.product.create({
    data: {
      sellerId, categoryId, title: `Old Product ${seq}`, slug: `old-product-${seq}`, description: 'Priced before GST was split out.',
      basePricePaise: buyerPaise, status: ProductStatus.APPROVED, approvedAt: new Date(),
      images: { create: [{ url: '/uploads/demo/a.jpg', sortOrder: 0 }] },
      weightGrams: 350, lengthMm: 300, widthMm: 200, heightMm: 50,
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, optionValues: {}, sku: `OLD-${seq}`, pricePaise: buyerPaise, mrpPaise: null, stock: 5 },
  });
  return { product, variant };
}

const variantOf = (productId: string) => prisma.productVariant.findFirstOrThrow({ where: { productId } });

describe('a seller prices before GST', () => {
  it('stores their price and charges the buyer price + GST: ₹100 at 18% is ₹118', async () => {
    const s = await seller();
    const cat = await category({ defaultTaxRatePercent: 18 });
    const res = await call('POST', '/api/seller/products', s.token, body(cat, [{ optionValues: {}, sellerPricePaise: 10_000, sellerMrpPaise: 15_000, stock: 3 }]));
    expect(res.status).toBe(200);
    const id = (res.json.data as unknown as { id: string }).id;
    const v = await variantOf(id);
    expect([v.sellerPricePaise, v.pricePaise, v.sellerMrpPaise, v.mrpPaise]).toEqual([10_000, 11_800, 15_000, 17_700]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id } })).basePricePaise).toBe(11_800);

    // Shoppers see the buyer price, GST included.
    await prisma.product.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    const slug = (await prisma.product.findUniqueOrThrow({ where: { id } })).slug;
    const page = (await call('GET', `/api/products/${slug}`, null)).json.data as unknown as { variants: { pricePaise: number }[] };
    expect(page.variants[0].pricePaise).toBe(11_800);

    // The form gets both back.
    const detail = (await call('GET', `/api/seller/products/${id}`, s.token)).json.data as unknown as {
      variants: { sellerPricePaise: number; buyerPricePaise: number; sellerMrpPaise: number; buyerMrpPaise: number }[];
    };
    expect(detail.variants[0]).toMatchObject({ sellerPricePaise: 10_000, buyerPricePaise: 11_800, sellerMrpPaise: 15_000, buyerMrpPaise: 17_700 });
  });

  it('decides the apparel slab on the seller price, books at nil', async () => {
    const s = await seller();
    const apparel = await category({ taxRule: 'VALUE_SLAB' });
    const books = await category({ defaultTaxRatePercent: 0 });
    const res = await call('POST', '/api/seller/products', s.token, body(apparel, [
      { optionValues: { size: 'M' }, sellerPricePaise: 250_000, stock: 1 },
      { optionValues: { size: 'L' }, sellerPricePaise: 250_001, stock: 1 },
    ]));
    const variants = await prisma.productVariant.findMany({
      where: { productId: (res.json.data as unknown as { id: string }).id },
      orderBy: { sellerPricePaise: 'asc' },
    });
    expect(variants.map((v) => v.pricePaise)).toEqual([262_500, 295_001]);
    const book = await call('POST', '/api/seller/products', s.token, body(books, [{ optionValues: {}, sellerPricePaise: 49_900, stock: 1 }]));
    expect((await variantOf((book.json.data as unknown as { id: string }).id)).pricePaise).toBe(49_900);
  });
});

describe('a listing priced before this change', () => {
  it('shows the seller the price before GST, and keeps the buyer price to the paisa when re-saved', async () => {
    const s = await seller();
    const cat = await category({ defaultTaxRatePercent: 18 });
    // A buyer price no seller price rebuilds exactly (some inclusive prices
    // fall between two seller prices' rounding steps).
    let buyer = 100_000;
    while (buyerPriceFor(sellerPriceFromBuyer(buyer, { taxRule: null, defaultTaxRatePercent: 18 }, GST).exGstPaise, { taxRule: null, defaultTaxRatePercent: 18 }, GST).buyerPaise === buyer) buyer += 1;
    const { product, variant } = await legacyListing(s.sellerId, cat, buyer);

    const detail = (await call('GET', `/api/seller/products/${product.id}`, s.token)).json.data as unknown as {
      variants: { id: string; sellerPricePaise: number; buyerPricePaise: number }[];
    };
    const derived = sellerPriceFromBuyer(buyer, { taxRule: null, defaultTaxRatePercent: 18 }, GST).exGstPaise;
    expect(detail.variants[0]).toMatchObject({ sellerPricePaise: derived, buyerPricePaise: buyer });

    const saved = await call('PUT', `/api/seller/products/${product.id}`, s.token, body(cat, [
      { id: variant.id, optionValues: {}, sellerPricePaise: derived, stock: 9 },
    ], { title: product.title, description: product.description }));
    expect(saved.status).toBe(200);
    const after = await variantOf(product.id);
    expect([after.pricePaise, after.sellerPricePaise, after.stock]).toEqual([buyer, derived, 9]);

    // A real price change is priced fresh: seller ₹500 → buyer ₹590.
    await call('PUT', `/api/seller/products/${product.id}`, s.token, body(cat, [
      { id: variant.id, optionValues: {}, sellerPricePaise: 50_000, stock: 9 },
    ], { title: product.title, description: product.description }));
    expect((await variantOf(product.id)).pricePaise).toBe(59_000);
  });

  it('gets its seller price from the backfill, dry run first, with no buyer price moving', async () => {
    const s = await seller();
    const cat = await category({ taxRule: 'VALUE_SLAB' });
    const plain = await legacyListing(s.sellerId, cat, 99_900);
    const band = await legacyListing(s.sellerId, cat, 280_000);
    const where = { id: { in: [plain.product.id, band.product.id] } };

    const dry = await ensureSellerPrices(where, false);
    expect(dry.map((c) => [c.buyerBefore, c.buyerAfter, c.sellerPrice, c.ratePercent, c.ambiguous])).toEqual([
      [99_900, 99_900, 95_143, 5, false],
      [280_000, 280_000, 237_288, 18, true],
    ]);
    expect((await variantOf(plain.product.id)).sellerPricePaise).toBeNull();

    await ensureSellerPrices(where, true);
    const [a, b] = [await variantOf(plain.product.id), await variantOf(band.product.id)];
    expect([a.pricePaise, a.sellerPricePaise, b.pricePaise, b.sellerPricePaise]).toEqual([99_900, 95_143, 280_000, 237_288]);
    expect(await ensureSellerPrices(where, false)).toEqual([]);
  });
});

describe('when GST rules change', () => {
  it('a rate change moves buyer prices and leaves sellers’ prices alone', async () => {
    const s = await seller();
    const cat = await category(); // no rule of its own: the standard rate
    const res = await call('POST', '/api/seller/products', s.token, body(cat, [{ optionValues: {}, sellerPricePaise: 10_000, stock: 1 }]));
    const fresh = (res.json.data as unknown as { id: string }).id;
    const old = await legacyListing(s.sellerId, cat, 59_000); // ₹500 + 18% the old way

    const put = (gstStandardPercent: number) => call('PUT', '/api/admin/settings', adminToken, { gstStandardPercent });
    expect((await put(12)).status).toBe(200);
    const [a, b] = [await variantOf(fresh), await variantOf(old.product.id)];
    expect([a.sellerPricePaise, a.pricePaise]).toEqual([10_000, 11_200]);
    // The old listing's seller price was taken under 18% before the change.
    expect([b.sellerPricePaise, b.pricePaise]).toEqual([50_000, 56_000]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: old.product.id } })).basePricePaise).toBe(56_000);

    expect((await put(GST.standardPercent)).status).toBe(200);
    expect((await variantOf(fresh)).pricePaise).toBe(11_800);
  });

  it("a category's GST rule change reprices its listings", async () => {
    const s = await seller();
    const cat = await category({ defaultTaxRatePercent: 18 });
    const res = await call('POST', '/api/seller/products', s.token, body(cat, [{ optionValues: {}, sellerPricePaise: 10_000, stock: 1 }]));
    const id = (res.json.data as unknown as { id: string }).id;
    expect((await call('PATCH', `/api/admin/categories/${cat}`, adminToken, { defaultTaxRatePercent: 5 })).status).toBe(200);
    const v = await variantOf(id);
    expect([v.sellerPricePaise, v.pricePaise]).toEqual([10_000, 10_500]);
  });

  it('an approved move to another category reprices the listing', async () => {
    const s = await seller();
    const from = await category({ defaultTaxRatePercent: 18 });
    const to = await category({ defaultTaxRatePercent: 5 });
    const created = await call('POST', '/api/seller/products', s.token, body(from, [{ optionValues: {}, sellerPricePaise: 10_000, stock: 1 }]));
    const id = (created.json.data as unknown as { id: string }).id;
    await prisma.product.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    const v = await variantOf(id);

    const edit = await call('PUT', `/api/seller/products/${id}`, s.token, body(to, [{ id: v.id, optionValues: {}, sellerPricePaise: 10_000, stock: 1 }]));
    expect(edit.status).toBe(200);
    expect((await variantOf(id)).pricePaise).toBe(11_800); // still live in the 18% category
    expect((await call('PATCH', `/api/admin/products/${id}/revision`, adminToken, { action: 'approve' })).status).toBe(200);
    expect((await variantOf(id)).pricePaise).toBe(10_500);
  });
});
