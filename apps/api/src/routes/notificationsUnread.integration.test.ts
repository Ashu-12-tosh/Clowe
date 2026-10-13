import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import type { UnreadNotifications } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * The badge endpoint every open tab polls: a new notification (an admin's
 * approval, say) shows in the count and moves latestAt; reading clears it.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;
let userId: string;

const unread = async () => {
  const res = await fetch(`${base}/api/notifications/unread`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: UnreadNotifications }).data;
};

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { phone: '9198600001', name: 'Badge Watcher', role: Role.SELLER, referralCode: 'BADG-1' },
  });
  userId = user.id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('GET /api/notifications/unread', () => {
  it('is empty with nothing received', async () => {
    expect(await unread()).toEqual({ unreadCount: 0, latestAt: null });
  });

  it('counts a new notification and reports when it arrived', async () => {
    const n = await prisma.notification.create({
      data: { userId, type: 'SELLER_APPROVED', title: 'Seller account approved', body: 'You can now list products.' },
    });
    expect(await unread()).toEqual({ unreadCount: 1, latestAt: n.createdAt.toISOString() });
  });

  it('drops the count once read, keeping latestAt', async () => {
    const before = await unread();
    await fetch(`${base}/api/notifications/read-all`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(await unread()).toEqual({ unreadCount: 0, latestAt: before.latestAt });
  });

  it('needs a signed-in user', async () => {
    expect((await fetch(`${base}/api/notifications/unread`)).status).toBe(401);
  });
});
