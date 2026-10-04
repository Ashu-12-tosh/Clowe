import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { OtpSendError, otpProvider } from '../services/otp';

/**
 * What the client sees when the code goes out, and when it cannot.
 *
 * The provider is stubbed (no SMS); the rest is real — Express, the auth
 * route, Postgres. A failed send gets one answer whether or not the number
 * has an account, and once a real provider is live the code never comes back
 * in the response or reaches the log.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

const P = {
  customer: '9195000001',
  seller: '9195000002',
  unknown: '9195000999',
  real: '9195000003',
  mock: '9195000004',
};

beforeAll(async () => {
  await seedFixture(prisma);
  await prisma.user.create({ data: { phone: P.customer, name: 'Send Customer', referralCode: 'SEND-C' } });
  const seller = await prisma.user.create({
    data: { phone: P.seller, name: 'Send Seller', role: Role.SELLER, referralCode: 'SEND-S' },
  });
  await prisma.sellerProfile.create({ data: { userId: seller.id, shopName: 'Send Shop', status: SellerStatus.APPROVED } });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function requestOtp(phone: string) {
  const res = await fetch(`${base}/api/auth/request-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  return { status: res.status, text: await res.text() };
}

/** Pretend a real SMS provider is live, recording the codes it is handed. */
function realProvider(send: (code: string) => Promise<void>) {
  const codes: string[] = [];
  Object.defineProperty(otpProvider, 'name', { value: 'smspanel', configurable: true });
  vi.spyOn(otpProvider, 'sendOtp').mockImplementation(async (_phone, code) => {
    codes.push(code);
    await send(code);
  });
  return codes;
}

afterEach(() => {
  Object.defineProperty(otpProvider, 'name', { value: 'mock', configurable: true });
});

describe('when the code cannot be sent', () => {
  it('answers every number the same — registered, seller or unknown — with a clear try-again message', async () => {
    realProvider(async () => {
      throw new OtpSendError('low_balance');
    });
    const answers = [await requestOtp(P.customer), await requestOtp(P.seller), await requestOtp(P.unknown)];

    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0].status).toBe(503);
    expect(JSON.parse(answers[0].text).error).toEqual({
      code: 'OTP_SEND_FAILED',
      message: "We couldn't send the code. Please try again.",
    });
    // Nothing about why: no provider, reason or panel text.
    expect(answers[0].text).not.toMatch(/balance|panel|smspanel|alots/i);
  });

  it('drops the unsent code, so trying again works at once instead of hitting the resend wait', async () => {
    expect(await prisma.otpCode.count({ where: { phone: { in: [P.customer, P.seller, P.unknown] } } })).toBe(0);

    realProvider(async () => {});
    const retry = await requestOtp(P.customer);
    expect(retry.status).toBe(200);
    expect(await prisma.otpCode.count({ where: { phone: P.customer } })).toBe(1);
  });
});

describe('when the code is sent', () => {
  it('with a real provider: the code is not in the response, nor in anything logged', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    const codes = realProvider(async () => {});

    const res = await requestOtp(P.real);
    expect(res.status).toBe(200);
    expect(codes).toHaveLength(1);
    expect(JSON.parse(res.text).data).toEqual({ resendAfterSec: 45 });
    expect(res.text).not.toContain(codes[0]);
    expect(logged.join('\n')).not.toContain(codes[0]);
  });

  it('with the mock outside production: the code still comes back for the dev login page', async () => {
    const res = await requestOtp(P.mock);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).data.devOtp).toMatch(/^\d{6}$/);
  });
});
