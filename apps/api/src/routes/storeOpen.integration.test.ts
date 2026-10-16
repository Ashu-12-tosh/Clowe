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
      expect(r.json.error).toMatchObject({ code: 'STORE_NOT_OPEN', message: "We're launching soon — orders open shortly" });
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

  it('the admin closes and opens it from Settings', async () => {
    const admin = await user(Role.ADMIN);
    const shopper = await user();
    expect((await call('PUT', '/api/admin/settings', admin.token, { storeOpenForOrders: false })).status).toBe(200);
    expect((await call<{ open: boolean }>('GET', '/api/orders/availability', shopper.token)).json.data.open).toBe(false);
    expect((await call('PUT', '/api/admin/settings', admin.token, { storeOpenForOrders: true })).status).toBe(200);
    expect((await call<{ open: boolean }>('GET', '/api/orders/availability', shopper.token)).json.data.open).toBe(true);
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
