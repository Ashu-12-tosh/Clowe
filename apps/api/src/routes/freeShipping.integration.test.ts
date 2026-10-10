import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * Free standard delivery is one platform setting (₹999 by default), read by
 * the cart, the delivery options and checkout, and published for every page
 * that mentions it. Changing it in admin changes all of them at once.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let shopperToken: string;
let variantId: string;
let addressId: string;

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown> & Array<unknown> } };
}

const cart = async () => (await call('GET', '/api/cart', shopperToken)).json.data as unknown as {
  subtotalPaise: number;
  shippingPaise: number;
  freeShippingThresholdPaise: number;
};
const standardPrice = async () =>
  ((await call('GET', '/api/cart/delivery-options', shopperToken)).json.data as unknown as { method: string; pricePaise: number }[])
    .find((o) => o.method === 'STANDARD')!.pricePaise;

beforeAll(async () => {
  await seedFixture(prisma);
  await setSetting('freeShippingThresholdPaise', DEFAULT_SETTINGS.freeShippingThresholdPaise);
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id, categoryId: category.id, title: 'Free Shipping Test Book', slug: 'free-shipping-test-book',
      description: 'A ₹600 book.', basePricePaise: 60_000, status: ProductStatus.APPROVED, approvedAt: new Date(),
    },
  });
  variantId = (
    await prisma.productVariant.create({
      data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-FREESHIP', pricePaise: 60_000, stock: 50 },
    })
  ).id;

  const admin = await prisma.user.create({ data: { phone: '9199000001', name: 'Ship Admin', role: Role.ADMIN, referralCode: 'SHIP-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const shopper = await prisma.user.create({ data: { phone: '9199000002', name: 'Ship Shopper', referralCode: 'SHIP-C' } });
  shopperToken = signAccessToken({ sub: shopper.id, role: 'CUSTOMER' });
  addressId = (
    await prisma.address.create({
      data: { userId: shopper.id, name: 'Ship Shopper', phone: '9199000002', line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
    })
  ).id;

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await call('POST', '/api/cart/items', shopperToken, { variantId, quantity: 1 }); // ₹600
});

afterAll(async () => {
  await setSetting('freeShippingThresholdPaise', DEFAULT_SETTINGS.freeShippingThresholdPaise);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the setting', () => {
  it('defaults to ₹999 and is published to every page', async () => {
    expect(DEFAULT_SETTINGS.freeShippingThresholdPaise).toBe(99_900);
    const pub = (await call('GET', '/api/settings/public', null)).json.data!;
    expect(pub.freeShippingThresholdPaise).toBe(99_900);
  });

  it('charges standard delivery below it, in the cart and the delivery options', async () => {
    const c = await cart();
    expect(c.subtotalPaise).toBe(60_000);
    expect(c.freeShippingThresholdPaise).toBe(99_900);
    expect(c.shippingPaise).toBeGreaterThan(0);
    expect(await standardPrice()).toBe(c.shippingPaise);
  });

  it('is followed everywhere when an admin changes it — cart, options and checkout', async () => {
    const put = await call('PUT', '/api/admin/settings', adminToken, { freeShippingThresholdPaise: 50_000 }); // ₹500
    expect(put.status).toBe(200);
    expect((await call('GET', '/api/settings/public', null)).json.data!.freeShippingThresholdPaise).toBe(50_000);

    const c = await cart();
    expect(c.freeShippingThresholdPaise).toBe(50_000);
    expect(c.shippingPaise).toBe(0);
    expect(await standardPrice()).toBe(0);

    const order = await call('POST', '/api/orders/checkout', shopperToken, { addressId, paymentMethod: 'COD' });
    expect(order.status).toBe(200);
    const placed = await prisma.order.findUniqueOrThrow({ where: { id: (order.json.data as unknown as { orderId: string }).orderId } });
    expect(placed.shippingPaise).toBe(0);
  });

  it('charges again once it moves back above the order', async () => {
    await call('PUT', '/api/admin/settings', adminToken, { freeShippingThresholdPaise: 99_900 });
    await call('POST', '/api/cart/items', shopperToken, { variantId, quantity: 1 });
    const c = await cart();
    expect(c.subtotalPaise).toBe(60_000);
    expect(c.shippingPaise).toBeGreaterThan(0);
  });
});
