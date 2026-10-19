import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { authService } from '../services/authService';

/**
 * What the sign-in endpoints tell about an account. The old phone checks
 * answer the same for every number; PIN login now says what went wrong (see
 * its block below for why).
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

const P = {
  withPin: '9194000001',
  withoutPin: '9194000002',
  deactivated: '9194000003',
  fresh: '9194000004',
  seller: '9194000005',
  unknown: '9194000999',
};

beforeAll(async () => {
  await seedFixture(prisma);
  const make = async (phone: string, opts: { pin?: string; active?: boolean } = {}) => {
    const user = await prisma.user.create({
      data: { phone, name: `Enum ${phone.slice(-3)}`, referralCode: `ENUM-${phone.slice(-3)}`, isActive: opts.active ?? true },
    });
    if (opts.pin) await authService.setPin(user.id, opts.pin);
  };
  await make(P.withPin, { pin: '2468' });
  await make(P.withoutPin);
  await make(P.deactivated, { pin: '1357', active: false });
  await make(P.fresh, { pin: '9753' });
  const seller = await prisma.user.create({ data: { phone: P.seller, name: 'Enum Seller', role: Role.SELLER, referralCode: 'ENUM-S' } });
  await prisma.sellerProfile.create({ data: { userId: seller.id, shopName: 'Enum Shop', status: SellerStatus.APPROVED } });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

const pinLogin = (phone: string, pin: string) => post('/api/auth/pin-login', { phone, pin });

// The owner's login redesign (pre-launch audit 2026-10-20, D1) says whether a
// number has an account ("No account found — create one"), so PIN login says
// what went wrong instead of one answer for everything; the lookup is
// rate-limited (loginRedesign.integration.test.ts). A deactivated account is
// still told only to someone who got its PIN right.
describe('PIN login', () => {
  it('says what went wrong: no account, no PIN yet, wrong PIN', async () => {
    const codeOf = async (r: Promise<{ text: string }>) => JSON.parse((await r).text).error.code;
    expect(await codeOf(pinLogin(P.unknown, '1111'))).toBe('NO_ACCOUNT');
    expect(await codeOf(pinLogin(P.withoutPin, '1111'))).toBe('PIN_NOT_SET');
    expect(await codeOf(pinLogin(P.withPin, '1111'))).toBe('PIN_INVALID');
    expect(await codeOf(pinLogin(P.deactivated, '1111'))).toBe('PIN_INVALID');
  });

  it('signs in with the right PIN, and tells a deactivated account only once its PIN is right', async () => {
    expect((await pinLogin(P.fresh, '9753')).status).toBe(200);
    const disabled = await pinLogin(P.deactivated, '1357');
    expect(disabled.status).toBe(403);
    expect(JSON.parse(disabled.text).error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('the old phone checks, kept for pages loaded before the change', () => {
  it('gives every number the same answer, which sends it to OTP', async () => {
    const answers = [];
    for (const phone of [P.withPin, P.withoutPin, P.deactivated, P.fresh, P.unknown]) {
      answers.push(await post('/api/auth/check-phone', { phone }));
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0].status).toBe(200);
    expect(JSON.parse(answers[0].text).data).toEqual({ exists: false, hasPin: false });
  });

  it('gives every number the same seller answer, which lets it go on to OTP', async () => {
    const answers = [];
    for (const phone of [P.seller, P.withPin, P.unknown]) {
      answers.push(await post('/api/seller/check-phone', { phone }));
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0].status).toBe(200);
    expect(JSON.parse(answers[0].text).data).toEqual({ isSeller: true });
  });
});
