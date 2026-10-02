import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { FIXTURE, seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { invalidateCategoryRules } from '../services/categoryRules';
import { signAccessToken } from '../utils/jwt';

/**
 * The return window is one platform setting (5 days by default), read by
 * every page and by the return endpoint. Each order line keeps the window it
 * was sold with: checkout stores it, and the return endpoint reads it, so a
 * later change to the setting never moves a window already sold.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
let fixtureSellerId: string;

const DAY = 86_400_000;

beforeAll(async () => {
  await seedFixture(prisma);
  const seller = await prisma.sellerProfile.findFirstOrThrow({ where: { slug: 'fixture-store' } });
  fixtureSellerId = seller.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await prisma.platformSetting.deleteMany({ where: { key: 'returnWindowDays' } });
  await prisma.sellerProfile.update({ where: { id: fixtureSellerId }, data: { returnWindowDays: null } });
  await prisma.category.updateMany({ data: { returnWindowDays: null } });
  invalidateCategoryRules();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function call(method: string, urlPath: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  return { status: res.status, json };
}

async function shopper() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `95500${String(seq).padStart(5, '0')}`, name: `Window Shopper ${seq}`, referralCode: `RW-U-${seq}` },
  });
  const address = await prisma.address.create({
    data: {
      userId: user.id,
      name: user.name!,
      phone: user.phone,
      line1: '1 Test Lane',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      isDefault: true,
    },
  });
  return { userId: user.id, addressId: address.id, token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }) };
}

/** Check out one fixture product; returns the window stored on its line. */
async function buy(slug: string): Promise<number | null> {
  const s = await shopper();
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { product: { slug } } });
  await prisma.cart.create({ data: { userId: s.userId, items: { create: [{ variantId: variant.id, quantity: 1 }] } } });
  const res = await call('POST', '/api/orders/checkout', s.token, { addressId: s.addressId, paymentMethod: 'UPI' });
  expect(res.status).toBe(200);
  const line = await prisma.orderItem.findFirstOrThrow({ where: { order: { userId: s.userId } } });
  return line.returnWindowDays;
}

/** A line delivered `daysAgo` days ago, sold with `windowDays`. */
async function deliveredLine(windowDays: number | null, daysAgo: number) {
  const s = await shopper();
  const product = await prisma.product.findUniqueOrThrow({
    where: { slug: FIXTURE.phoneWordedPlainly },
    include: { variants: { take: 1 } },
  });
  seq += 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: `CLW-RW-${String(seq).padStart(6, '0')}`,
      userId: s.userId,
      shipName: 'Window Shopper',
      shipPhone: '9550000000',
      shipLine1: '1 Test Lane',
      shipCity: 'Mumbai',
      shipState: 'Maharashtra',
      shipPincode: '400001',
      status: 'DELIVERED',
      subtotalPaise: 300_000,
      totalPaise: 300_000,
      paymentMethod: 'UPI',
      items: {
        create: {
          productId: product.id,
          variantId: product.variants[0].id,
          sellerId: product.sellerId,
          title: product.title,
          size: '',
          color: '',
          pricePaise: 300_000,
          quantity: 1,
          status: 'DELIVERED',
          deliveredAt: new Date(Date.now() - daysAgo * DAY),
          returnWindowDays: windowDays,
        },
      },
    },
    include: { items: true },
  });
  return { ...s, orderId: order.id, itemId: order.items[0].id };
}

const requestReturn = (line: { token: string; itemId: string }) =>
  call('POST', `/api/orders/items/${line.itemId}/return`, line.token, { reason: 'SIZE_FIT', details: 'Too small' });

// ---------------------------------------------------------------------------

describe('the setting', () => {
  it('defaults to 5 days and is published to every page', async () => {
    expect(DEFAULT_SETTINGS.returnWindowDays).toBe(5);
    const pub = await call('GET', '/api/settings/public', null);
    expect(pub.json.data?.returnWindowDays).toBe(5);
    const product = await call('GET', `/api/products/${FIXTURE.phoneWordedPlainly}`, null);
    expect(product.json.data?.returnWindowDays).toBe(5);
  });

  it('is followed everywhere when an admin changes it', async () => {
    await setSetting('returnWindowDays', 9);
    expect((await call('GET', '/api/settings/public', null)).json.data?.returnWindowDays).toBe(9);
    const product = await call('GET', `/api/products/${FIXTURE.phoneWordedPlainly}`, null);
    expect(product.json.data?.returnWindowDays).toBe(9);
  });

  it("sets the floor for a seller's own window", async () => {
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: fixtureSellerId } });
    const token = signAccessToken({ sub: seller.userId, role: 'SELLER' });
    const shorter = await call('PUT', '/api/seller/store/returns', token, {
      returnWindowDays: 4,
      returnAddressSameAsPickup: true,
    });
    expect(shorter.status).toBe(400);
    expect(shorter.json.error?.code).toBe('WINDOW_TOO_SHORT');
    expect(shorter.json.error?.message).toContain('5 days');
    const store = await call('GET', '/api/seller/store', token);
    const settings = store.json.data?.settings as { platformReturnWindowDays: number; effectiveReturnWindowDays: number };
    expect(settings.platformReturnWindowDays).toBe(5);
    expect(settings.effectiveReturnWindowDays).toBe(5);
  });
});

describe('checkout', () => {
  it('stores on each line the window it is sold with', async () => {
    expect(await buy(FIXTURE.phoneWordedPlainly)).toBe(5);
    await setSetting('returnWindowDays', 8);
    expect(await buy(FIXTURE.phoneWordedPlainly)).toBe(8);
  });

  it("stores the seller's or the category's own window where one is set", async () => {
    await prisma.category.update({ where: { slug: 'mobiles' }, data: { returnWindowDays: 3 } });
    invalidateCategoryRules();
    expect(await buy(FIXTURE.phoneWordedPlainly)).toBe(3); // inherited from the parent category
    await prisma.sellerProfile.update({ where: { id: fixtureSellerId }, data: { returnWindowDays: 12 } });
    expect(await buy(FIXTURE.phoneWordedPlainly)).toBe(12);
  });
});

describe('a line already sold', () => {
  it('keeps a 7-day window after the platform moves to 5', async () => {
    const line = await deliveredLine(7, 6);
    const detail = await call('GET', `/api/orders/${line.orderId}`, line.token);
    expect(detail.json.data?.returnWindowDays).toBe(7);
    expect((detail.json.data?.items as { canReturn: boolean }[])[0].canReturn).toBe(true);
    const res = await requestReturn(line);
    expect(res.status).toBe(200);
  });

  it('closes on its own window, not a longer setting', async () => {
    await setSetting('returnWindowDays', 10);
    const line = await deliveredLine(5, 6);
    const detail = await call('GET', `/api/orders/${line.orderId}`, line.token);
    expect((detail.json.data?.items as { canReturn: boolean }[])[0].canReturn).toBe(false);
    const res = await requestReturn(line);
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('RETURN_WINDOW_CLOSED');
    expect(res.json.error?.message).toContain('within 5 days');
  });
});

describe('the migration backfill', () => {
  // Step 2 of the migration, run as written against lines that predate it.
  const sql = fs
    .readFileSync(
      path.resolve(__dirname, '../../prisma/migrations/20261007120000_return_window_setting/migration.sql'),
      'utf8',
    )
    .split('-- 3.')[0]
    .split(/^WITH RECURSIVE/m)[1];

  async function sellerWithProduct(categorySlug: string, sellerDays: number | null) {
    seq += 1;
    const user = await prisma.user.create({
      data: { phone: `95600${String(seq).padStart(5, '0')}`, name: `RW Seller ${seq}`, role: Role.SELLER, referralCode: `RW-S-${seq}` },
    });
    const seller = await prisma.sellerProfile.create({
      data: { userId: user.id, shopName: `RW Shop ${seq}`, status: SellerStatus.APPROVED, returnWindowDays: sellerDays },
    });
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: categorySlug } });
    const product = await prisma.product.create({
      data: {
        sellerId: seller.id,
        categoryId: category.id,
        title: `RW Product ${seq}`,
        slug: `rw-product-${seq}`,
        description: 'Return window backfill.',
        basePricePaise: 100_000,
        status: ProductStatus.APPROVED,
      },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: `SKU-RW-${seq}`, pricePaise: 100_000, stock: 5 },
    });
    const s = await shopper();
    const order = await prisma.order.create({
      data: {
        orderNumber: `CLW-RWB-${String(seq).padStart(6, '0')}`,
        userId: s.userId,
        shipName: 'x',
        shipPhone: '9560000000',
        shipLine1: 'x',
        shipCity: 'x',
        shipState: 'x',
        shipPincode: '400001',
        status: 'DELIVERED',
        subtotalPaise: 100_000,
        totalPaise: 100_000,
        paymentMethod: 'UPI',
        items: {
          create: {
            productId: product.id,
            variantId: variant.id,
            sellerId: seller.id,
            title: product.title,
            size: '',
            color: '',
            pricePaise: 100_000,
            quantity: 1,
            status: 'DELIVERED',
            deliveredAt: new Date(),
          },
        },
      },
      include: { items: true },
    });
    return order.items[0].id;
  }

  const windowOf = async (id: string) => (await prisma.orderItem.findUniqueOrThrow({ where: { id } })).returnWindowDays;

  it('gives each old line the window it was sold with', async () => {
    expect(sql).toContain('UPDATE "order_items"');
    await prisma.category.update({ where: { slug: 'mobiles' }, data: { returnWindowDays: 10 } });

    const fromCategory = await sellerWithProduct('mobiles-smartphones', null); // nearest ancestor: 10
    const fromSeller = await sellerWithProduct('mobiles-smartphones', 14); // the seller's own wins
    const fromPlatform = await sellerWithProduct('books', null); // nothing set: the platform setting
    for (const id of [fromCategory, fromSeller, fromPlatform]) expect(await windowOf(id)).toBeNull();

    await setSetting('returnWindowDays', 6);
    await prisma.$executeRawUnsafe(`WITH RECURSIVE${sql}`);
    expect(await windowOf(fromCategory)).toBe(10);
    expect(await windowOf(fromSeller)).toBe(14);
    expect(await windowOf(fromPlatform)).toBe(6);

    // With no saved setting, the platform default until now: 7 days.
    await prisma.platformSetting.deleteMany({ where: { key: 'returnWindowDays' } });
    await prisma.orderItem.update({ where: { id: fromPlatform }, data: { returnWindowDays: null } });
    await prisma.$executeRawUnsafe(`WITH RECURSIVE${sql}`);
    expect(await windowOf(fromPlatform)).toBe(7);
  });
});
