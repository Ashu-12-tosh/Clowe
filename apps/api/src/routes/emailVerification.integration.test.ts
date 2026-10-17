import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { bridgeNotifications } from '../services/email';
import { signAccessToken } from '../utils/jwt';

/**
 * A shopper's email: saved from sign-up, checkout or My Account, confirmed by
 * a one-time link (48 hours). Order emails go to confirmed addresses only.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let userId: string;
let token: string;

async function call<T = Record<string, unknown>>(method: string, path: string, auth: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

/** The link's token, read from the queued email. */
async function linkToken(to: string): Promise<string> {
  const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { toEmail: to, kind: 'EMAIL_VERIFY' }, orderBy: { createdAt: 'desc' } });
  return /verify-email\?token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
}

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { phone: '9177500001', name: 'Asha Verify', referralCode: 'EV-1' } })).id;
  await prisma.user.create({ data: { phone: '9177500002', name: 'Taken', email: 'taken@example.com', referralCode: 'EV-2' } });
  token = signAccessToken({ sub: userId, role: 'CUSTOMER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a shopper’s email address', () => {
  it('refuses a badly formed or someone else’s address', async () => {
    const bad = await call('PATCH', '/api/auth/me', token, { email: 'asha@' });
    expect(bad.status).toBe(400);
    const taken = await call('PATCH', '/api/auth/me', token, { email: 'TAKEN@example.com' });
    expect(taken.json.error?.code).toBe('EMAIL_TAKEN');
  });

  it('is saved unconfirmed, and a one-time link is emailed', async () => {
    const r = await call<{ email: string; emailVerified: boolean }>('PATCH', '/api/auth/me', token, { email: '  Asha.Verify@Example.com ' });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ email: 'asha.verify@example.com', emailVerified: false });
    const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { toEmail: 'asha.verify@example.com', kind: 'EMAIL_VERIFY' } });
    expect(mail.subject).toBe('Confirm your email for Clowe');
    expect(mail.html).toContain('Confirm my email');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.emailVerifyTokenHash).toHaveLength(64); // only the hash is stored
    expect(mail.text).not.toContain(u.emailVerifyTokenHash!);
  });

  it('a second link within a minute is refused', async () => {
    const r = await call('POST', '/api/auth/me/email/resend', token);
    expect(r.json.error?.code).toBe('EMAIL_LINK_TOO_SOON');
  });

  it('order emails wait until the address is confirmed', async () => {
    await prisma.platformSetting.deleteMany({ where: { key: 'email.bridge' } });
    await bridgeNotifications(); // starts from now
    await new Promise((r) => setTimeout(r, 20));
    const n = await prisma.notification.create({ data: { userId, type: 'ORDER_CONFIRMED', title: 'Order placed', body: 'Your order is placed.' } });
    await bridgeNotifications();
    expect(await prisma.emailOutbox.count({ where: { dedupeKey: `n:${n.id}` } })).toBe(0);
  });

  it('the link confirms once, then stops working', async () => {
    const t = await linkToken('asha.verify@example.com');
    const ok = await call<{ email: string }>('POST', '/api/auth/verify-email', null, { token: t });
    expect(ok.json.data).toEqual({ email: 'asha.verify@example.com' });
    expect((await call<{ emailVerified: boolean }>('GET', '/api/auth/me', token)).json.data.emailVerified).toBe(true);
    const again = await call('POST', '/api/auth/verify-email', null, { token: t });
    expect(again.json.error?.code).toBe('EMAIL_LINK_INVALID');
    // Confirmed: order emails go now.
    await new Promise((r) => setTimeout(r, 20));
    const n = await prisma.notification.create({ data: { userId, type: 'ITEM_SHIPPED', title: 'Shipped', body: 'On its way.' } });
    await bridgeNotifications();
    expect(await prisma.emailOutbox.count({ where: { dedupeKey: `n:${n.id}` } })).toBe(1);
  });

  it('a changed address is unconfirmed again; an old link has expired after 48 hours', async () => {
    const r = await call<{ emailVerified: boolean }>('PATCH', '/api/auth/me', token, { email: 'asha.new@example.com' });
    expect(r.json.data.emailVerified).toBe(false);
    const t = await linkToken('asha.new@example.com');
    await prisma.user.update({ where: { id: userId }, data: { emailVerifySentAt: new Date(Date.now() - 49 * 3_600_000) } });
    const expired = await call('POST', '/api/auth/verify-email', null, { token: t });
    expect(expired.json.error?.code).toBe('EMAIL_LINK_EXPIRED');
    // A new link replaces it and works.
    expect((await call('POST', '/api/auth/me/email/resend', token)).status).toBe(200);
    const t2 = await linkToken('asha.new@example.com');
    expect(t2).not.toBe(t);
    expect((await call('POST', '/api/auth/verify-email', null, { token: t2 })).status).toBe(200);
  });

  it('at most five links a day', async () => {
    let code: string | undefined;
    for (let i = 0; i < 8 && !code; i++) {
      await prisma.user.update({ where: { id: userId }, data: { emailVerifySentAt: null } }); // past the one-minute gap
      code = (await call('PATCH', '/api/auth/me', token, { email: `asha.${i}@example.com` })).json.error?.code;
    }
    expect(code).toBe('EMAIL_LINK_DAILY_LIMIT');
    expect(await prisma.emailOutbox.count({ where: { userId, kind: 'EMAIL_VERIFY' } })).toBe(5);
  });

  it('can be removed', async () => {
    const r = await call<{ email: string | null }>('PATCH', '/api/auth/me', token, { email: '' });
    expect(r.json.data.email).toBeNull();
  });
});
