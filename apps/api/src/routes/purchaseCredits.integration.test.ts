import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { settleEarnedCredits } from '../services/purchaseCredits';
import { signAccessToken } from '../utils/jwt';

/**
 * Reward credits follow what was actually bought. An order's credits come
 * back off the balance when it is cancelled (prepaid or COD) and, for the
 * returned share, when lines are returned. A buyer cannot keep credits from an
 * order they did not pay for — not even by spending them first.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let sellerToken: string;
let cheapVariant: string; // ₹800
let dearVariant: string; // ₹1,200
let seq = 0;

interface Body {
  data: { orderId: string; items: { id: string; title: string }[]; earnedCredits: number; totalPaise: number };
  error?: { code: string; message: string };
}
async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

async function shopper() {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91970${String(seq).padStart(5, '0')}`, name: `Credit Buyer ${seq}`, referralCode: `CRD-${seq}` } });
  const address = await prisma.address.create({
    data: { userId: user.id, name: 'Credit Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
  });
  return { id: user.id, token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }), addressId: address.id };
}

async function order(
  b: { token: string; addressId: string },
  lines: string[],
  method: 'UPI' | 'COD',
  extra: Record<string, unknown> = {},
) {
  for (const variantId of lines) expect((await call('POST', '/api/cart/items', b.token, { variantId, quantity: 1 })).status).toBe(200);
  const co = await call('POST', '/api/orders/checkout', b.token, { addressId: b.addressId, paymentMethod: method, ...extra });
  expect(co.status).toBe(200);
  const orderId = co.json.data.orderId;
  if (method !== 'COD') expect((await call('POST', '/api/payments/mock-pay', b.token, { orderId, outcome: 'success' })).status).toBe(200);
  return orderId;
}

const balance = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditsBalance;
const earnedOn = async (orderId: string) =>
  (await prisma.creditLedger.aggregate({ where: { orderId, reason: 'EARN_PURCHASE' }, _sum: { delta: true } }))._sum.delta ?? 0;

/** Deliver the order's lines (test shortcut), then return one through the real seller flow. */
async function returnLine(b: { token: string }, orderId: string, itemId: string) {
  await prisma.orderItem.updateMany({ where: { orderId }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
  expect((await call('POST', `/api/orders/items/${itemId}/return`, b.token, { reason: 'SIZE_FIT' })).status).toBe(200);
  const ret = await prisma.return.findFirstOrThrow({ where: { orderItemId: itemId } });
  expect((await call('PATCH', `/api/seller/returns/${ret.id}`, sellerToken, { action: 'approve' })).status).toBe(200);
  expect((await call('PATCH', `/api/seller/returns/${ret.id}`, sellerToken, { action: 'received', condition: 'OK' })).status).toBe(200);
}

beforeAll(async () => {
  await seedFixture(prisma);
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  sellerToken = signAccessToken({ sub: seller.userId, role: 'SELLER' });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const make = async (slug: string, pricePaise: number) => {
    const p = await prisma.product.create({
      data: { sellerId: seller.id, categoryId: category.id, title: slug, slug, description: 'Credits test.', basePricePaise: pricePaise, status: ProductStatus.APPROVED, approvedAt: new Date() },
    });
    return (await prisma.productVariant.create({ data: { productId: p.id, optionValues: {}, optionsKey: '', label: '', sku: `SKU-${slug}`, pricePaise, stock: 100 } })).id;
  };
  cheapVariant = await make('credits-cheap', 80_000);
  dearVariant = await make('credits-dear', 120_000);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('cancelling', () => {
  it('a paid order takes its reward back', async () => {
    const b = await shopper();
    const orderId = await order(b, [cheapVariant, dearVariant], 'UPI');
    const earned = await earnedOn(orderId);
    expect(earned).toBeGreaterThan(0);
    expect(await balance(b.id)).toBe(earned);

    expect((await call('POST', `/api/orders/${orderId}/cancel`, b.token)).status).toBe(200);
    expect(await balance(b.id)).toBe(0);
    expect(await prisma.creditLedger.findFirst({ where: { orderId, reason: 'REVERSE_PURCHASE' } })).toMatchObject({ delta: -earned });
    expect((await call('GET', `/api/orders/${orderId}`, b.token)).json.data.earnedCredits).toBe(0);
  });

  it('a COD order — which earns on placement, before any money is collected — takes it back too', async () => {
    const b = await shopper();
    const orderId = await order(b, [dearVariant], 'COD');
    expect(await earnedOn(orderId)).toBeGreaterThan(0);
    expect((await call('POST', `/api/orders/${orderId}/cancel`, b.token)).status).toBe(200);
    expect(await balance(b.id)).toBe(0);
  });
});

describe('returning', () => {
  it('the whole order takes the whole reward back', async () => {
    const b = await shopper();
    const orderId = await order(b, [cheapVariant], 'UPI');
    expect(await balance(b.id)).toBeGreaterThan(0);
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
    await returnLine(b, orderId, item.id);
    expect(await prisma.refund.count({ where: { orderId, status: 'PROCESSED' } })).toBe(1);
    expect(await balance(b.id)).toBe(0);
  });

  it('part of the order takes back the returned share and keeps the rest', async () => {
    const b = await shopper();
    const orderId = await order(b, [cheapVariant, dearVariant], 'UPI');
    const earned = await earnedOn(orderId);
    const cheap = await prisma.orderItem.findFirstOrThrow({ where: { orderId, pricePaise: 80_000 } });
    await returnLine(b, orderId, cheap.id);

    // ₹1,200 of ₹2,000 is still bought.
    const keep = Math.floor((earned * 120_000) / 200_000);
    expect(await balance(b.id)).toBe(keep);
    expect(keep).toBeGreaterThan(0);
    expect(keep).toBeLessThan(earned);
  });
});

describe('a buyer who spends the credits before cancelling', () => {
  it('owes them back: the balance goes below zero, and checkout never turns that into a negative discount', async () => {
    const b = await shopper();
    const first = await order(b, [dearVariant], 'UPI');
    const earned = await earnedOn(first);

    // Spend them on a second order.
    const second = await order(b, [cheapVariant], 'UPI', { useCredits: true });
    const spent = (await prisma.order.findUniqueOrThrow({ where: { id: second } })).creditsUsed;
    expect(spent).toBeGreaterThan(0);
    const before = await balance(b.id);

    expect((await call('POST', `/api/orders/${first}/cancel`, b.token)).status).toBe(200);
    expect(await balance(b.id)).toBe(before - earned);
    expect(await balance(b.id)).toBeLessThan(0);

    // A third order with credits ticked pays full price — no negative "discount".
    const third = await order(b, [cheapVariant], 'UPI', { useCredits: true });
    const placed = await prisma.order.findUniqueOrThrow({ where: { id: third } });
    expect(placed.creditsUsed).toBe(0);
    expect(placed.totalPaise).toBeGreaterThanOrEqual(80_000);
  });
});

it('settling again posts nothing more', async () => {
  const b = await shopper();
  const orderId = await order(b, [dearVariant], 'UPI');
  expect((await call('POST', `/api/orders/${orderId}/cancel`, b.token)).status).toBe(200);
  const after = await balance(b.id);
  expect(await settleEarnedCredits(orderId)).toBe(0);
  expect(await settleEarnedCredits(orderId)).toBe(0);
  expect(await balance(b.id)).toBe(after);
  expect(await prisma.creditLedger.count({ where: { orderId, reason: 'REVERSE_PURCHASE' } })).toBe(1);
});
