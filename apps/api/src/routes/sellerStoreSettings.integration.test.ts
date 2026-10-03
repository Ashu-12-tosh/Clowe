import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { STORE_TABS, STORE_TAB_LABELS } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * Store Settings: the "Vacation" tab keeps vacation mode only. Working hours
 * (and social links) stay stored but are no longer edited, sent or shown to
 * shoppers.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

const HOURS = { mon: { open: '08:00', close: '20:00', closed: false }, sun: { open: '10:00', close: '14:00', closed: true } };
const SOCIALS = { website: 'https://shop.example', instagram: 'https://instagram.com/shop', facebook: '', youtube: '' };

beforeAll(async () => {
  await seedFixture(prisma);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown> } };
}

async function storeWithHours() {
  const user = await prisma.user.create({
    data: { phone: '9170000001', name: 'Hours Seller', role: Role.SELLER, referralCode: 'HOURS-S' },
  });
  const seller = await prisma.sellerProfile.create({
    data: {
      userId: user.id,
      shopName: 'Hours Shop',
      slug: 'hours-shop',
      status: SellerStatus.APPROVED,
      approvedAt: new Date(),
      workingHours: HOURS,
      socialLinks: SOCIALS,
    },
  });
  return { sellerId: seller.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

describe('the Vacation tab', () => {
  it('is called Vacation, and there is no hours tab', () => {
    expect(STORE_TABS).toContain('VACATION');
    expect(STORE_TABS).not.toContain('HOURS');
    expect(STORE_TAB_LABELS.VACATION).toBe('Vacation');
  });

  it('switches vacation mode and leaves the stored working hours as they were', async () => {
    const s = await storeWithHours();
    const on = await call('PUT', '/api/seller/store/vacation', s.token, {
      vacationMode: true,
      vacationMessage: 'Back on Monday',
    });
    expect(on.status).toBe(200);
    const stored = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.sellerId } });
    expect(stored.vacationMode).toBe(true);
    expect(stored.vacationMessage).toBe('Back on Monday');
    expect(stored.workingHours).toEqual(HOURS);
    expect(stored.socialLinks).toEqual(SOCIALS);

    // The old endpoint is gone, and the settings no longer carry the hours.
    expect((await call('PUT', '/api/seller/store/hours', s.token, { vacationMode: false })).status).toBe(404);
    const settings = (await call('GET', '/api/seller/store', s.token)).json.data?.settings as Record<string, unknown>;
    expect(settings).not.toHaveProperty('workingHours');
    expect(settings).toMatchObject({ vacationMode: true });
  });
});

describe('the public store page', () => {
  it('shows shoppers no store hours (and no social links)', async () => {
    const res = await call('GET', '/api/stores/hours-shop', null);
    expect(res.status).toBe(200);
    expect(res.json.data).not.toHaveProperty('workingHours');
    expect(res.json.data).not.toHaveProperty('socialLinks');
    expect(res.json.data).toMatchObject({ shopName: 'Hours Shop' });
  });
});
