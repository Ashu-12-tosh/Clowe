import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { bridgeNotifications } from '../services/email';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * A seller hears of a new order at once (pre-launch audit 2026-10-21, M4):
 * the bell opens the order itself, and an email gives the lines, the payment
 * and the time to ship by — to the account email or, failing that, the
 * store's contact email (registration never asks for an account email).
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let variantId: string;
let sellerUserId: string;
let sellerId: string;
let seq = 0;

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { data: { orderId: string } } };
}

async function order(method: 'UPI' | 'COD') {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91957${String(seq).padStart(5, '0')}`, name: `Notice Buyer ${seq}`, referralCode: `NTC-${seq}` } });
  const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
  const address = await prisma.address.create({ data: { userId: user.id, name: 'Notice Buyer', phone: user.phone, line1: '1 Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true } });
  expect((await call('POST', '/api/cart/items', token, { variantId, quantity: 2 })).status).toBe(200);
  const co = await call('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: method });
  expect(co.status, JSON.stringify(co.json)).toBe(200);
  if (method !== 'COD') await call('POST', '/api/payments/mock-pay', token, { orderId: co.json.data.orderId, outcome: 'success' });
  return co.json.data.orderId;
}

beforeAll(async () => {
  await seedFixture(prisma);
  await setSetting('codMinOrderPaise', 0);
  const seller = await prisma.sellerProfile.update({ where: { slug: 'fixture-store' }, data: { storeEmail: 'orders@fixture-store.example' } });
  sellerId = seller.id;
  sellerUserId = seller.userId;
  await prisma.user.update({ where: { id: sellerUserId }, data: { email: null } });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: { sellerId, categoryId: category.id, title: 'Notice Novel', slug: 'notice-novel', description: 'For the new-order notice tests.', basePricePaise: 45_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  variantId = (await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-NTC', pricePaise: 45_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The bridge starts from its first run: start it now, so it would see these orders' notifications.
  await bridgeNotifications(new Date(Date.now() - 60_000));
});

afterAll(async () => {
  await setSetting('codMinOrderPaise', DEFAULT_SETTINGS.codMinOrderPaise);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a seller’s new order', () => {
  it('prepaid: the bell opens the order and names the ship-by time; one email, to the store email, with the lines', async () => {
    const orderId = await order('UPI');
    const { orderNumber } = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const bell = await prisma.notification.findFirstOrThrow({ where: { userId: sellerUserId, type: 'NEW_ORDER', body: { contains: orderNumber } } });
    expect(bell).toMatchObject({ title: 'New order received 🛍', linkHref: `/seller/orders/${orderId}` });
    expect(bell.body).toMatch(/2 items to ship by \d{1,2} \w{3}, \d{1,2}:\d{2}\s?[ap]m\. Paid online\./i);

    await bridgeNotifications();
    const mails = await prisma.emailOutbox.findMany({ where: { userId: sellerUserId, subject: { contains: orderNumber } } });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ toEmail: 'orders@fixture-store.example', kind: 'NEW_ORDER' });
    expect(mails[0]!.subject).toMatch(new RegExp(`^New order ${orderNumber} — ship by .+ — Clowe$`));
    expect(mails[0]!.text).toContain('Notice Novel × 2 — ₹900');
    expect(mails[0]!.html).toContain(`/seller/orders/${orderId}`);
  });

  it('COD: says what the courier collects; the account email is preferred when there is one', async () => {
    await prisma.user.update({ where: { id: sellerUserId }, data: { email: 'owner@fixture-store.example' } });
    try {
      const orderId = await order('COD');
      const { orderNumber } = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const bell = await prisma.notification.findFirstOrThrow({ where: { userId: sellerUserId, type: 'NEW_ORDER', body: { contains: orderNumber } } });
      expect(bell.title).toBe('New COD order received 🛍');
      expect(bell.body).toContain('the courier collects ₹900 on handover');
      await bridgeNotifications();
      const mails = await prisma.emailOutbox.findMany({ where: { userId: sellerUserId, subject: { contains: orderNumber } } });
      expect(mails.map((m) => m.toEmail)).toEqual(['owner@fixture-store.example']);
    } finally {
      await prisma.user.update({ where: { id: sellerUserId }, data: { email: null } });
    }
  });
});
