import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { FIXTURE, seedFixture } from '../test/fixture';
import { invalidateCategoryRules } from '../services/categoryRules';
import { signAccessToken } from '../utils/jwt';

/**
 * Non-returnable categories. A category (or a subcategory, overriding its
 * parent) can be set "not returnable": its products say so on the product
 * page, in the cart and at checkout; each order line keeps the answer it was
 * sold with; the order has no return button and the API refuses a return.
 * The Return Policy lists the categories from the same setting.
 *
 * The fixture phone sits in Mobiles › Smartphones.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
const DAY = 86_400_000;

beforeAll(async () => {
  await seedFixture(prisma);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await prisma.category.updateMany({ data: { returnable: null } });
  invalidateCategoryRules();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function call(method: string, urlPath: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: { code: string } };
  return { status: res.status, json };
}

async function setReturnable(slug: string, returnable: boolean | null) {
  await prisma.category.update({ where: { slug }, data: { returnable } });
  invalidateCategoryRules();
}

async function shopper() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `95600${String(seq).padStart(5, '0')}`, name: `NR Shopper ${seq}`, referralCode: `NR-U-${seq}` },
  });
  const address = await prisma.address.create({
    data: { userId: user.id, name: user.name!, phone: user.phone, line1: '1 Test Lane', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', isDefault: true },
  });
  return { userId: user.id, addressId: address.id, token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }) };
}

const product = () => call('GET', `/api/products/${FIXTURE.phoneWordedPlainly}`, null);
const listed = async () => (await call('GET', '/api/settings/public', null)).json.data?.nonReturnableCategories;

describe('the Returnable setting', () => {
  it('is on by default', async () => {
    expect((await product()).json.data?.returnable).toBe(true);
    expect(await listed()).toEqual([]);
  });

  it('a subcategory set off makes its products non-returnable, and the Return Policy lists it', async () => {
    await setReturnable('mobiles-smartphones', false);
    expect((await product()).json.data?.returnable).toBe(false);
    expect(await listed()).toEqual(['Mobiles › Smartphones']);
  });

  it('a parent set off covers its subcategories (listed once, at the top)', async () => {
    await setReturnable('mobiles', false);
    expect((await product()).json.data?.returnable).toBe(false);
    expect(await listed()).toEqual(['Mobiles']);
  });

  it('a subcategory can override its parent back on', async () => {
    await setReturnable('mobiles', false);
    await setReturnable('mobiles-smartphones', true);
    expect((await product()).json.data?.returnable).toBe(true);
  });
});

describe('before buying', () => {
  it('the cart says so on the line', async () => {
    await setReturnable('mobiles-smartphones', false);
    const s = await shopper();
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { product: { slug: FIXTURE.phoneWordedPlainly } } });
    await prisma.cart.create({ data: { userId: s.userId, items: { create: [{ variantId: variant.id, quantity: 1 }] } } });
    const cart = await call('GET', '/api/cart', s.token);
    const lines = cart.json.data?.lines as { productId: string; returnable: boolean }[];
    expect(lines[0]!.returnable).toBe(false);
  });
});

describe('after buying', () => {
  it('checkout fixes the answer on the line; a later change does not move it', async () => {
    await setReturnable('mobiles-smartphones', false);
    const s = await shopper();
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { product: { slug: FIXTURE.phoneWordedPlainly } } });
    await prisma.cart.create({ data: { userId: s.userId, items: { create: [{ variantId: variant.id, quantity: 1 }] } } });
    expect((await call('POST', '/api/orders/checkout', s.token, { addressId: s.addressId, paymentMethod: 'UPI' })).status).toBe(200);
    const line = await prisma.orderItem.findFirstOrThrow({ where: { order: { userId: s.userId } } });
    expect(line.returnable).toBe(false);

    // The category turns returnable later: this sale stays as it was sold.
    await setReturnable('mobiles-smartphones', true);
    await prisma.orderItem.update({ where: { id: line.id }, data: { status: 'DELIVERED', deliveredAt: new Date(Date.now() - DAY) } });
    const order = await call('GET', `/api/orders/${line.orderId}`, s.token);
    const item = (order.json.data?.items as { id: string; returnable: boolean; canReturn: boolean }[])[0]!;
    expect(item).toMatchObject({ returnable: false, canReturn: false });

    const refused = await call('POST', `/api/orders/items/${line.id}/return`, s.token, { reason: 'SIZE_FIT', details: 'Too small' });
    expect(refused.status).toBe(400);
    expect(refused.json.error?.code).toBe('NOT_RETURNABLE');
  });

  it('a returnable line keeps its return button', async () => {
    const s = await shopper();
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { product: { slug: FIXTURE.phoneWordedPlainly } } });
    await prisma.cart.create({ data: { userId: s.userId, items: { create: [{ variantId: variant.id, quantity: 1 }] } } });
    await call('POST', '/api/orders/checkout', s.token, { addressId: s.addressId, paymentMethod: 'UPI' });
    const line = await prisma.orderItem.findFirstOrThrow({ where: { order: { userId: s.userId } } });
    expect(line.returnable).toBe(true);
    await prisma.orderItem.update({ where: { id: line.id }, data: { status: 'DELIVERED', deliveredAt: new Date(Date.now() - DAY) } });
    const order = await call('GET', `/api/orders/${line.orderId}`, s.token);
    expect((order.json.data?.items as { canReturn: boolean }[])[0]!.canReturn).toBe(true);
  });
});

describe("a seller's own Not returnable flag", () => {
  afterEach(async () => {
    await prisma.product.update({ where: { slug: FIXTURE.phoneWordedPlainly }, data: { nonReturnable: false } });
  });

  it('makes one product non-returnable in a returnable category', async () => {
    await prisma.product.update({ where: { slug: FIXTURE.phoneWordedPlainly }, data: { nonReturnable: true } });
    expect((await product()).json.data?.returnable).toBe(false);
    const s = await shopper();
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { product: { slug: FIXTURE.phoneWordedPlainly } } });
    await prisma.cart.create({ data: { userId: s.userId, items: { create: [{ variantId: variant.id, quantity: 1 }] } } });
    const lines = (await call('GET', '/api/cart', s.token)).json.data?.lines as { returnable: boolean }[];
    expect(lines[0]!.returnable).toBe(false);
    await call('POST', '/api/orders/checkout', s.token, { addressId: s.addressId, paymentMethod: 'UPI' });
    expect((await prisma.orderItem.findFirstOrThrow({ where: { order: { userId: s.userId } } })).returnable).toBe(false);
  });

  it('cannot make a product in a non-returnable category returnable', async () => {
    await setReturnable('mobiles-smartphones', false);
    expect((await product()).json.data?.returnable).toBe(false);
  });
});
