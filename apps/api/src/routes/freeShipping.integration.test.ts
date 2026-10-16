import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * Buyers never pay a delivery fee: the cart, the delivery options, checkout
 * and phone orders all charge ₹0 at any order value, and only standard
 * delivery is offered. The old free-shipping threshold stays in the database,
 * unread and unpublished; orders placed before keep what they were charged.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let shopperToken: string;
let shopperId: string;
let variantId: string;
let addressId: string;
const orderIds: string[] = [];

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown> & Array<unknown>; error?: { code?: string } } };
}

const cart = async () => (await call('GET', '/api/cart', shopperToken)).json.data as unknown as Record<string, number>;
const options = async () =>
  (await call('GET', '/api/cart/delivery-options', shopperToken)).json.data as unknown as { method: string; pricePaise: number; strikePaise: number | null }[];

beforeAll(async () => {
  await seedFixture(prisma);
  // These carts are under ₹1,000; the COD floor itself is codCap's test.
  await setSetting('codMinOrderPaise', 0);
  // A threshold saved before stays in the database, and is ignored.
  await setSetting('freeShippingThresholdPaise', 99_900);
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id, categoryId: category.id, title: 'Free Delivery Test Book', slug: 'free-shipping-test-book',
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
  shopperId = shopper.id;
  shopperToken = signAccessToken({ sub: shopper.id, role: 'CUSTOMER' });
  addressId = (
    await prisma.address.create({
      data: { userId: shopper.id, name: 'Ship Shopper', phone: '9199000002', line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
    })
  ).id;

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await call('POST', '/api/cart/items', shopperToken, { variantId, quantity: 1 }); // ₹600, under the old ₹999
});

afterAll(async () => {
  await setSetting('codMinOrderPaise', DEFAULT_SETTINGS.codMinOrderPaise);
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('free delivery on all orders', () => {
  it('charges no delivery in the cart, under what used to be the threshold', async () => {
    const c = await cart();
    expect(c.subtotalPaise).toBe(60_000);
    expect(c.shippingPaise).toBe(0);
    expect(c.totalPaise).toBe(60_000);
    expect(c).not.toHaveProperty('freeShippingThresholdPaise');
  });

  it('offers standard delivery only, free, with nothing struck through', async () => {
    expect(await options()).toEqual([expect.objectContaining({ method: 'STANDARD', pricePaise: 0, strikePaise: null, available: true })]);
    const pub = (await call('GET', '/api/delivery/options?pincode=411001&subtotalPaise=100', null)).json.data as unknown as { options: { method: string; pricePaise: number }[] };
    expect(pub.options.map((o) => [o.method, o.pricePaise])).toEqual([['STANDARD', 0]]);
  });

  it('no longer publishes the threshold, and an admin can no longer set it', async () => {
    const pub = (await call('GET', '/api/settings/public', null)).json.data!;
    expect(pub).not.toHaveProperty('freeShippingThresholdPaise');
    await call('PUT', '/api/admin/settings', adminToken, { freeShippingThresholdPaise: 1 });
    // The old row is kept as it was, unread.
    const row = await prisma.platformSetting.findUnique({ where: { key: 'freeShippingThresholdPaise' } });
    expect(row?.value).toBe(99_900);
  });

  it('refuses the paid speeds at checkout', async () => {
    for (const deliveryMethod of ['EXPRESS', 'SAME_DAY']) {
      const r = await call('POST', '/api/orders/checkout', shopperToken, { addressId, paymentMethod: 'COD', deliveryMethod });
      expect(r.status, deliveryMethod).toBe(400);
      expect(r.json.error?.code).toBe('DELIVERY_UNAVAILABLE');
    }
  });

  it('places the order with no delivery charge', async () => {
    const order = await call('POST', '/api/orders/checkout', shopperToken, { addressId, paymentMethod: 'COD' });
    expect(order.status).toBe(200);
    const id = (order.json.data as unknown as { orderId: string }).orderId;
    orderIds.push(id);
    const placed = await prisma.order.findUniqueOrThrow({ where: { id } });
    expect(placed).toMatchObject({ shippingPaise: 0, subtotalPaise: 60_000, totalPaise: 60_000, deliveryMethod: 'STANDARD' });
  });

  it('charges a phone order no delivery either, and offers it no paid speed', async () => {
    const r = await call('POST', '/api/admin/orders/manual', adminToken, {
      userId: shopperId, addressId, paymentMethod: 'COD', items: [{ variantId, quantity: 1 }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const placed = await prisma.order.findFirstOrThrow({ where: { orderNumber: (r.json.data as unknown as { orderNumber: string }).orderNumber } });
    orderIds.push(placed.id);
    expect(placed.shippingPaise).toBe(0);
    expect(placed.totalPaise).toBe(60_000);
    const express = await call('POST', '/api/admin/orders/manual', adminToken, {
      userId: shopperId, addressId, paymentMethod: 'COD', deliveryMethod: 'EXPRESS', items: [{ variantId, quantity: 1 }],
    });
    expect(express.status).toBe(400);
  });

  it('leaves orders placed before with the delivery fee they were charged', async () => {
    const old = await prisma.order.create({
      data: {
        userId: shopperId, orderNumber: 'CLW-2026-990001', status: 'DELIVERED', subtotalPaise: 60_000, shippingPaise: 4_900, totalPaise: 64_900,
        shipName: 'Ship Shopper', shipPhone: '9199000002', shipLine1: '1 Test Road', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
      },
    });
    orderIds.push(old.id);
    const mine = (await call('GET', `/api/orders/${old.id}`, shopperToken)).json.data as unknown as { shippingPaise: number; totalPaise: number };
    expect(mine).toMatchObject({ shippingPaise: 4_900, totalPaise: 64_900 });
  });
});
