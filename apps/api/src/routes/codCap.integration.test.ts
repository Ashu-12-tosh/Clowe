import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { FIXTURE, seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * Cash on Delivery is offered up to PlatformSettings.codMaxOrderPaise.
 *
 * The ceiling used to be a constant in packages/shared (₹20,000). It is a
 * setting now, enforced where the order is created, so the case that matters
 * most here is the last one: the server must follow the setting, not a number
 * compiled in — a UI that greys COD out at the right amount while the API
 * accepts any amount would pass every other case.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;

beforeAll(async () => {
  await seedFixture(prisma);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await setSetting('codMaxOrderPaise', DEFAULT_SETTINGS.codMaxOrderPaise);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** A shopper with an address and a cart holding the given fixture products. */
async function shopperWithCart(slugs: string[]) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `97000${String(seq).padStart(5, '0')}`, name: `COD Shopper ${seq}`, referralCode: `COD-U-${seq}` },
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
  const variants = await prisma.productVariant.findMany({
    where: { product: { slug: { in: slugs } } },
    select: { id: true },
  });
  expect(variants).toHaveLength(slugs.length);
  await prisma.cart.create({
    data: { userId: user.id, items: { create: variants.map((v) => ({ variantId: v.id, quantity: 1 })) } },
  });
  return {
    userId: user.id,
    addressId: address.id,
    token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }),
  };
}

async function checkout(token: string, addressId: string, paymentMethod: 'COD' | 'UPI') {
  const res = await fetch(`${base}/api/orders/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ addressId, paymentMethod }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { requiresPayment: boolean; payment: { provider: string } };
    error?: { code: string; message: string };
  };
  return { status: res.status, json };
}

// Fixture prices: ₹3,000 (plain-worded phone), ₹2,000 and ₹2,500 (the rated
// pair). Both carts clear the free-shipping threshold, so totals are exact.
const UNDER_CAP = [FIXTURE.phoneWordedPlainly]; // ₹3,000
const OVER_CAP = [FIXTURE.phoneWordedPlainly, FIXTURE.ratedHighLowCount, FIXTURE.ratedGoodHighCount]; // ₹7,500

describe('the COD ceiling', () => {
  it('refuses COD above it, and creates no order', async () => {
    const s = await shopperWithCart(OVER_CAP);
    const { status, json } = await checkout(s.token, s.addressId, 'COD');
    expect(status).toBe(400);
    expect(json.error?.code).toBe('COD_NOT_ELIGIBLE');
    expect(json.error?.message).toContain('₹5000');
    expect(await prisma.order.count({ where: { userId: s.userId } })).toBe(0);
  });

  it('confirms a COD order under it without a payment step', async () => {
    const s = await shopperWithCart(UNDER_CAP);
    const { status, json } = await checkout(s.token, s.addressId, 'COD');
    expect(status).toBe(200);
    expect(json.data?.requiresPayment).toBe(false);
    expect(json.data?.payment.provider).toBe('cod');
    const order = await prisma.order.findFirst({ where: { userId: s.userId }, include: { payment: true } });
    expect(order?.status).toBe('CONFIRMED');
    expect(order?.payment?.provider).toBe('cod');
    expect(order?.payment?.status).toBe('CREATED');
  });

  it('is not a ceiling on paying online', async () => {
    const s = await shopperWithCart(OVER_CAP);
    const { status, json } = await checkout(s.token, s.addressId, 'UPI');
    expect(status).toBe(200);
    expect(json.data?.requiresPayment).toBe(true);
  });

  it('is published to the payment step', async () => {
    const res = await fetch(`${base}/api/settings/public`);
    const json = (await res.json()) as { data: { codMaxOrderPaise: number } };
    expect(json.data.codMaxOrderPaise).toBe(500000);
  });

  it('follows the setting, not a compiled-in number', async () => {
    // The same ₹3,000 cart that was fine above is refused once the ceiling
    // drops below it. A constant anywhere on the order path would pass the
    // first three cases and fail this one.
    await setSetting('codMaxOrderPaise', 200000);
    const s = await shopperWithCart(UNDER_CAP);
    const { status, json } = await checkout(s.token, s.addressId, 'COD');
    expect(status).toBe(400);
    expect(json.error?.code).toBe('COD_NOT_ELIGIBLE');
    expect(json.error?.message).toContain('₹2000');
  });
});
