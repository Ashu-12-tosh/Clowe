import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { sha256 } from '../utils/crypto';

/**
 * After "Resend OTP" the first SMS can still arrive, even after the second.
 * Any of the latest three still-valid codes signs in; one sign-in uses them
 * all up; wrong guesses still lock the newest code.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

/** A code as if sent `ageSec` ago (the resend cooldown blocks real back-to-back sends). */
async function sent(phone: string, code: string, ageSec: number) {
  const createdAt = new Date(Date.now() - ageSec * 1000);
  await prisma.otpCode.create({
    data: { phone, codeHash: sha256(code), createdAt, expiresAt: new Date(createdAt.getTime() + 5 * 60_000) },
  });
}

async function verify(phone: string, code: string) {
  const res = await fetch(`${base}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
  const body = (await res.json()) as { error?: { code: string } };
  return { status: res.status, code: body.error?.code };
}

beforeAll(() => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('signing in after a resend', () => {
  it('accepts the first code when it arrives after the resent one', async () => {
    await sent('9198700001', '111111', 120);
    await sent('9198700001', '222222', 30);
    expect((await verify('9198700001', '111111')).status).toBe(200);
  });

  it('uses up every code sent for that sign-in', async () => {
    await sent('9198700002', '333333', 120);
    await sent('9198700002', '444444', 30);
    expect((await verify('9198700002', '444444')).status).toBe(200);
    expect(await verify('9198700002', '333333')).toEqual({ status: 400, code: 'OTP_INVALID' });
  });

  it('accepts only the latest three codes', async () => {
    await sent('9198700003', '555551', 200);
    await sent('9198700003', '555552', 150);
    await sent('9198700003', '555553', 100);
    await sent('9198700003', '555554', 50);
    expect(await verify('9198700003', '555551')).toEqual({ status: 400, code: 'OTP_INCORRECT' });
    expect((await verify('9198700003', '555552')).status).toBe(200);
  });

  it('never accepts an expired code', async () => {
    await sent('9198700004', '666666', 6 * 60);
    await sent('9198700004', '777777', 30);
    expect(await verify('9198700004', '666666')).toEqual({ status: 400, code: 'OTP_INCORRECT' });
  });

  it('still locks after too many wrong guesses', async () => {
    await sent('9198700005', '888888', 120);
    await sent('9198700005', '999999', 30);
    for (let i = 0; i < 5; i++) expect((await verify('9198700005', '000000')).code).toBe('OTP_INCORRECT');
    expect(await verify('9198700005', '888888')).toEqual({ status: 429, code: 'OTP_LOCKED' });
  });
});
