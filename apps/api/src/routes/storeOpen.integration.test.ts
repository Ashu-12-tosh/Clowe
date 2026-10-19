import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { env } from '../env';
import { setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * The owner's pre-launch switch: while the store is closed nobody but admins
 * and admin-marked test accounts can place an order (COD too), and on
 * production the mock gateway marks nothing paid for anyone else. Browsing
 * and the cart are untouched.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;

async function user(role: Role = Role.CUSTOMER, isTestAccount = false) {
  seq += 1;
  const u = await prisma.user.create({ data: { phone: `91995${String(seq).padStart(5, '0')}`, name: `Launch ${seq}`, role, referralCode: `LAUNCH-${seq}`, isTestAccount } });
  return { id: u.id, token: signAccessToken({ sub: u.id, role }) };
}
async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

beforeAll(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await setSetting('storeOpenForOrders', true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('store closed for orders', () => {
  it('refuses a shopper’s order, COD included, and says so; browsing and the cart still work', async () => {
    await setSetting('storeOpenForOrders', false);
    const shopper = await user();
    expect((await call('GET', '/api/settings/public', null)).json.data).toMatchObject({ storeOpenForOrders: false });
    expect((await call<{ open: boolean }>('GET', '/api/orders/availability', shopper.token)).json.data.open).toBe(false);
    for (const paymentMethod of ['COD', 'UPI']) {
      const r = await call('POST', '/api/orders/checkout', shopper.token, { addressId: 'any', paymentMethod });
      expect(r.status).toBe(403);
      expect(r.json.error).toMatchObject({ code: 'STORE_NOT_OPEN', message: 'Orders open soon' });
    }
    expect((await call('GET', '/api/cart', shopper.token)).status).toBe(200);
    expect((await call('GET', '/api/products?limit=4', null)).status).toBe(200);
  });

  it('lets admins and test accounts through', async () => {
    await setSetting('storeOpenForOrders', false);
    const admin = await user(Role.ADMIN);
    const tester = await user(Role.CUSTOMER, true);
    for (const u of [admin, tester]) {
      expect((await call<{ open: boolean }>('GET', '/api/orders/availability', u.token)).json.data.open).toBe(true);
      const r = await call('POST', '/api/orders/checkout', u.token, { addressId: 'any', paymentMethod: 'COD' });
      expect(r.json.error?.code).not.toBe('STORE_NOT_OPEN');
    }
  });

  it('an admin marks and unmarks a test account, audit-logged', async () => {
    const admin = await user(Role.ADMIN);
    const shopper = await user();
    expect((await call('PATCH', `/api/admin/users/${shopper.id}/test-account`, admin.token, { isTestAccount: true })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: shopper.id } })).isTestAccount).toBe(true);
    expect((await call('PATCH', `/api/admin/users/${shopper.id}/test-account`, shopper.token, { isTestAccount: true })).status).toBe(403);
    await expect.poll(() => prisma.auditLog.count({ where: { entityId: shopper.id, action: 'Marked as test account' } })).toBe(1);
  });

  it('the admin closes it from Settings; opening waits for every live seller to be complete', async () => {
    const admin = await user(Role.ADMIN);
    const shopper = await user();
    // Confirmed: other files' sellers in the test database may already be on the checklist.
    expect((await call('PUT', '/api/admin/settings', admin.token, { storeOpenForOrders: false, confirmCloseWithBlockers: true })).status).toBe(200);
    expect((await call<{ open: boolean }>('GET', '/api/orders/availability', shopper.token)).json.data.open).toBe(false);
    // A seller with a live listing and no address or verified KYC blocks opening.
    const sellerUser = await user(Role.SELLER);
    const cat = await prisma.category.create({ data: { name: 'Launch Cat', slug: `launch-cat-${Date.now()}`, isActive: true } });
    const shop = await prisma.sellerProfile.create({ data: { userId: sellerUser.id, shopName: 'Launch Shop', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.product.create({ data: { sellerId: shop.id, categoryId: cat.id, title: 'Launch item', slug: `launch-item-${Date.now()}`, description: 'A live listing.', basePricePaise: 10_000, status: 'APPROVED', approvedAt: new Date() } });
    const blockers = (await call<{ shopName: string; missing: string[] }[]>('GET', '/api/admin/store-open-checklist', admin.token)).json.data;
    expect(blockers.find((b) => b.shopName === 'Launch Shop')?.missing).toContain('business address');
    const open = await call('PUT', '/api/admin/settings', admin.token, { storeOpenForOrders: true });
    expect(open.json.error?.code).toBe('STORE_OPEN_CHECKLIST');
    expect((await call<{ open: boolean }>('GET', '/api/orders/availability', shopper.token)).json.data.open).toBe(false);
    await setSetting('storeOpenForOrders', true);
    expect((await call<{ open: boolean }>('GET', '/api/orders/availability', shopper.token)).json.data.open).toBe(true);
  });

  // Pre-launch audit (2026-10-20): with the store closed, shopping-credit and
  // seller wallet top-ups still opened a gateway payment, and an order placed
  // before closing was handed a fresh checkout to pay.
  it('takes no money at all while closed: top-ups refused, an earlier order not reopened for payment', async () => {
    await setSetting('storeOpenForOrders', false);
    try {
      const shopper = await user();
      const credits = await call('POST', '/api/credits/purchase', shopper.token, { packageId: 'starter' });
      expect(credits.status).toBe(403);
      expect(credits.json.error?.code).toBe('STORE_NOT_OPEN');
      expect(await prisma.creditPurchase.count({ where: { userId: shopper.id } })).toBe(0);

      const sellerUser = await user(Role.SELLER);
      const shop = await prisma.sellerProfile.create({ data: { userId: sellerUser.id, shopName: `Top-up Shop ${seq}`, status: 'APPROVED', approvedAt: new Date() } });
      const topUp = await call('POST', '/api/seller/promotion-credits/purchase', sellerUser.token, { amountPaise: 50_000 });
      expect(topUp.json.error?.code).toBe('STORE_NOT_OPEN');
      expect(await prisma.promotionCreditPurchase.count({ where: { sellerId: shop.id } })).toBe(0);

      // A test account still can.
      const tester = await user(Role.CUSTOMER, true);
      expect((await call('POST', '/api/credits/purchase', tester.token, { packageId: 'starter' })).status).toBe(200);

      const order = await prisma.order.create({
        data: {
          userId: shopper.id,
          orderNumber: `CLW-2026-${String(880000 + seq)}`,
          status: 'PLACED',
          subtotalPaise: 10_000,
          shippingPaise: 0,
          totalPaise: 10_000,
          shipName: 'Launch Buyer',
          shipPhone: '9500000002',
          shipLine1: '1 Test Street',
          shipCity: 'Mumbai',
          shipState: 'Maharashtra',
          shipPincode: '400001',
          payment: { create: { provider: 'mock', providerOrderId: `mock_order_closed_${seq}`, amountPaise: 10_000 } },
        },
      });
      const closed = await call<{ outcome: string; message: string | null; checkout: unknown }>('POST', '/api/payments/confirm', shopper.token, { kind: 'ORDER', id: order.id });
      expect(closed.json.data).toMatchObject({ checkout: null, message: 'Orders open soon' });
      await setSetting('storeOpenForOrders', true);
      const open = await call<{ checkout: unknown }>('POST', '/api/payments/confirm', shopper.token, { kind: 'ORDER', id: order.id });
      expect(open.json.data.checkout).not.toBeNull();
      await prisma.order.delete({ where: { id: order.id } });
    } finally {
      await setSetting('storeOpenForOrders', true);
    }
  });
});

describe('the mock gateway on production', () => {
  it('marks nothing paid for a real account, only for admins and test accounts', async () => {
    const was = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    try {
      const shopper = await user();
      const tester = await user(Role.CUSTOMER, true);
      for (const [path, body] of [
        ['/api/payments/mock-pay', { orderId: 'x', outcome: 'success' }],
        ['/api/credits/purchase/x/mock-pay', { outcome: 'success' }],
      ] as const) {
        expect((await call(path === '/api/payments/mock-pay' ? 'POST' : 'POST', path, shopper.token, body)).json.error?.code).toBe('MOCK_PAYMENT_REFUSED');
        expect((await call('POST', path, tester.token, body)).json.error?.code).not.toBe('MOCK_PAYMENT_REFUSED');
      }
      // A decline is still allowed: it marks nothing paid.
      expect((await call('POST', '/api/payments/mock-pay', shopper.token, { orderId: 'x', outcome: 'failure' })).json.error?.code).not.toBe('MOCK_PAYMENT_REFUSED');
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = was;
    }
  });
});
