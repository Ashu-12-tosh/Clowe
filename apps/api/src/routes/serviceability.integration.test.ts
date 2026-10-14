import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { shippingProvider } from '../services/shipping';
import { signAccessToken } from '../utils/jwt';

/**
 * Delhivery has to deliver to the address, and for COD collect cash there,
 * up to its limit for that pincode. The product page's pincode check, the
 * payment step and checkout all ask; when Delhivery can't be reached nothing
 * is refused on its account. (Mock: 999999 is not served, 888888 is prepaid
 * only, COD is capped at ₹50,000.)
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let shopperToken: string;
let shopperId: string;
let variantId: string;
const addresses: Record<string, string> = {};
const orderIds: string[] = [];

async function call(method: string, path: string, body?: unknown, token: string | null = shopperToken) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; error?: { message: string; code?: string } } };
}

async function checkout(pincode: string, paymentMethod: 'COD' | 'UPI') {
  await call('POST', '/api/cart/items', { variantId, quantity: 1 });
  const r = await call('POST', '/api/orders/checkout', { addressId: addresses[pincode], paymentMethod });
  if (r.status === 200) orderIds.push((r.json.data as { orderId: string }).orderId);
  return r;
}

beforeAll(async () => {
  await seedFixture(prisma);
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id, categoryId: category.id, title: 'Pincode Test Book', slug: 'pincode-test-book', description: 'A ₹600 book.',
      basePricePaise: 60_000, status: ProductStatus.APPROVED, approvedAt: new Date(),
    },
  });
  variantId = (await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-PIN', pricePaise: 60_000, stock: 50 } })).id;
  const shopper = await prisma.user.create({ data: { phone: '9199300002', name: 'Pin Shopper', referralCode: 'PIN-C' } });
  shopperId = shopper.id;
  shopperToken = signAccessToken({ sub: shopper.id, role: 'CUSTOMER' });
  for (const pincode of ['411001', '999999', '888888']) {
    addresses[pincode] = (
      await prisma.address.create({
        data: { userId: shopper.id, name: 'Pin Shopper', phone: '9199300002', line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode },
      })
    ).id;
  }
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.cartItem.deleteMany({ where: { cart: { userId: shopperId } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the product page’s pincode check', () => {
  it('says when Delhivery doesn’t deliver there, and whether it collects cash', async () => {
    const no = (await call('GET', '/api/delivery/options?pincode=999999', undefined, null)).json.data;
    expect(no).toMatchObject({ serviceable: false, options: [], codAvailable: false });
    expect(no.message).toMatch(/doesn't deliver to 999999/);
    expect((await call('GET', '/api/delivery/options?pincode=888888', undefined, null)).json.data).toMatchObject({ serviceable: true, codAvailable: false });
    expect((await call('GET', '/api/delivery/options?pincode=411001', undefined, null)).json.data).toMatchObject({ serviceable: true, codAvailable: true });
  });
});

describe('checkout', () => {
  it('refuses an address Delhivery doesn’t deliver to', async () => {
    const r = await checkout('999999', 'UPI');
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe('PINCODE_NOT_SERVICEABLE');
  });

  it('refuses COD where Delhivery won’t collect cash, and takes the same order paid online', async () => {
    const cod = await checkout('888888', 'COD');
    expect(cod.status).toBe(400);
    expect(cod.json.error).toMatchObject({ code: 'COD_NOT_ELIGIBLE' });
    expect(cod.json.error?.message).toMatch(/isn't available at 888888/);
    expect((await checkout('888888', 'UPI')).status).toBe(200);
  });

  it('refuses COD above the pincode’s limit', async () => {
    vi.spyOn(shippingProvider, 'checkPincode').mockResolvedValueOnce({
      pincode: '411001', serviceable: true, prepaid: true, cod: true, pickup: true, reversePickup: true, codLimitPaise: 50_000, city: null, state: null,
    });
    const r = await checkout('411001', 'COD'); // ₹600 > ₹500
    expect(r.status).toBe(400);
    expect(r.json.error?.message).toMatch(/up to ₹500/);
  });

  it('greys COD out on the payment step with the reason', async () => {
    await call('POST', '/api/cart/items', { variantId, quantity: 1 });
    expect((await call('GET', `/api/cart/cod-availability?addressId=${addresses['888888']}`)).json.data).toMatchObject({
      available: false,
      reason: expect.stringMatching(/isn't available at 888888/),
    });
    expect((await call('GET', `/api/cart/cod-availability?addressId=${addresses['411001']}`)).json.data).toEqual({ available: true, reason: null });
  });

  it('does not refuse anything when Delhivery can’t be asked', async () => {
    vi.spyOn(shippingProvider, 'checkPincode').mockRejectedValue(new Error('Delhivery did not answer in time'));
    const r = await checkout('888888', 'COD');
    vi.restoreAllMocks();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });
});
