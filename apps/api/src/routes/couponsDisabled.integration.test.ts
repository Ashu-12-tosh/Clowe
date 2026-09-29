import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * Coupons behind the couponsEnabled switch.
 *
 * The feature is built, seeded and tested, and simply not offered: every way
 * in is hidden and the API refuses codes, while the table, the routes and the
 * discount recorded against past orders stay exactly as they were. These tests
 * exist to keep that true in both positions of the switch — a hiding that
 * quietly becomes a deletion, or one that only hides the button while the API
 * still honours a hand-made request, would both pass a casual look.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;

beforeAll(async () => {
  await seedFixture(prisma);
  // seedFixture is the search fixture and carries no coupons, so this file
  // brings its own rather than depending on the main seed script.
  await prisma.coupon.upsert({
    where: { code: 'TESTCPN10' },
    update: { isActive: true },
    create: {
      code: 'TESTCPN10',
      description: '10% off, for the coupon-switch tests',
      type: 'PERCENT',
      value: 10,
      isActive: true,
    },
  });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // Back to the shipped default between cases.
  await setSetting('couponsEnabled', false);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function makeShopper() {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `95000${String(seq).padStart(5, '0')}`,
      name: `Coupon Shopper ${seq}`,
      referralCode: `CPN-U-${seq}`,
    },
  });
  return { id: user.id, token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }) };
}

async function makeSeller() {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `96000${String(seq).padStart(5, '0')}`,
      name: `Coupon Seller ${seq}`,
      role: Role.SELLER,
      referralCode: `CPN-S-${seq}`,
    },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Coupon Shop ${seq}`, status: SellerStatus.APPROVED },
  });
  return { sellerId: seller.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: never;
    error?: { code: string };
  };
  return { status: res.status, json };
}

/** A promotion payload that is valid apart from whatever the case is testing. */
function promotionBody(extra: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    name: 'Season sale',
    scope: 'STORE',
    kind: 'PERCENT',
    value: 10,
    minOrderPaise: 0,
    startAt: new Date(now + 60_000).toISOString(),
    endAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    state: 'DRAFT',
    ...extra,
  };
}

// ---------------------------------------------------------------------------

describe('with coupons switched off', () => {
  it('refuses to apply a code, on the server and not just in the UI', async () => {
    const shopper = await makeShopper();
    const { status, json } = await call('POST', '/api/cart/coupon', shopper.token, {
      code: 'TESTCPN10',
    });
    expect(status).toBe(400);
    expect(json.error?.code).toBe('COUPONS_DISABLED');
  });

  it('offers none to browse and none in My Coupons', async () => {
    const shopper = await makeShopper();
    const browse = await call('GET', '/api/cart/coupons', shopper.token);
    expect(browse.status).toBe(200);
    expect(browse.json.data).toEqual([]);

    const mine = await call('GET', '/api/me/coupons', shopper.token);
    expect(mine.status).toBe(200);
    expect((mine.json.data as unknown as { coupons: unknown[] }).coupons).toEqual([]);
  });

  it('drops a code a cart was already carrying, and still lets it be removed', async () => {
    // A cart filled before the switch was flipped must not keep discounting.
    const shopper = await makeShopper();
    const cart = await prisma.cart.create({
      data: { userId: shopper.id, couponCode: 'TESTCPN10' },
    });

    const view = await call('GET', '/api/cart', shopper.token);
    expect(view.status).toBe(200);
    expect((view.json.data as unknown as { couponDiscountPaise: number }).couponDiscountPaise).toBe(0);

    const after = await prisma.cart.findUnique({ where: { id: cart.id } });
    expect(after!.couponCode).toBeNull();

    // DELETE stays open deliberately, so nobody is stuck with a stale code.
    const removed = await call('DELETE', '/api/cart/coupon', shopper.token);
    expect(removed.status).toBe(200);
  });

  it('keeps the coupons themselves — nothing is deleted', async () => {
    const coupons = await prisma.coupon.count();
    expect(coupons).toBeGreaterThan(0);
  });

  it('still reports the discount on an order that used one', async () => {
    // The whole point of hiding rather than removing: old maths keeps adding up.
    const shopper = await makeShopper();
    const order = await prisma.order.create({
      data: {
        userId: shopper.id,
        orderNumber: `CLW-2026-${String(700000 + seq)}`,
        status: 'PLACED',
        subtotalPaise: 100_000,
        shippingPaise: 0,
        totalPaise: 90_000,
        couponCode: 'CLOWE10',
        couponDiscountPaise: 10_000,
        shipName: 'Coupon Shopper',
        shipPhone: '9500000000',
        shipLine1: '1 Test Street',
        shipCity: 'Mumbai',
        shipState: 'Maharashtra',
        shipPincode: '400001',
      },
    });
    const { status, json } = await call('GET', `/api/orders/${order.id}`, shopper.token);
    expect(status).toBe(200);
    const body = json.data as unknown as { couponCode: string; couponDiscountPaise: number };
    expect(body.couponCode).toBe('CLOWE10');
    expect(body.couponDiscountPaise).toBe(10_000);

    // seedFixture clears users without clearing orders first, so an order left
    // behind here breaks the next test file's reset on the FK. This file made
    // it; this file takes it away.
    await prisma.order.delete({ where: { id: order.id } });
  });

});
