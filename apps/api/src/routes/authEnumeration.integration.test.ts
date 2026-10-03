import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { authService } from '../services/authService';

/**
 * The sign-in endpoints answer the same whether or not a phone number has an
 * account, so they cannot be used to find out which numbers do.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

const P = {
  withPin: '9194000001',
  withoutPin: '9194000002',
  deactivated: '9194000003',
  fresh: '9194000004',
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

describe('PIN login', () => {
  it('fails the same way for every reason: no account, no PIN, wrong PIN, deactivated', async () => {
    const answers = [
      await pinLogin(P.unknown, '1111'),
      await pinLogin(P.withoutPin, '1111'),
      await pinLogin(P.withPin, '1111'),
      await pinLogin(P.deactivated, '1111'),
    ];
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0].status).toBe(400);
    expect(JSON.parse(answers[0].text).error.code).toBe('PIN_INVALID');
  });

  it('answers a locked-out account the same way, even with the right PIN, until OTP clears it', async () => {
    const reference = await pinLogin(P.unknown, '1111');
    for (let i = 0; i < 5; i++) expect(await pinLogin(P.withPin, '0000')).toEqual(reference);
    expect(await pinLogin(P.withPin, '2468')).toEqual(reference);
    expect((await prisma.user.findUniqueOrThrow({ where: { phone: P.withPin } })).pinAttempts).toBeGreaterThanOrEqual(5);
  });

  it('signs in with the right PIN, and tells a deactivated account only once its PIN is right', async () => {
    expect((await pinLogin(P.fresh, '9753')).status).toBe(200);
    const disabled = await pinLogin(P.deactivated, '1357');
    expect(disabled.status).toBe(403);
    expect(JSON.parse(disabled.text).error.code).toBe('ACCOUNT_DISABLED');
  });
});
