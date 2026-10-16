import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TERMS_VERSION } from '@clowe/shared';
import { createApp } from '../app';

/**
 * Signing in with "By continuing you confirm you are 18+ and agree to the
 * Terms and Privacy Policy" shown stores that version, and when, on the
 * account. A stale page's version is not recorded.
 */
const prisma = new PrismaClient();
let server: Server;
let base: string;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

beforeAll(() => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function signIn(phone: string, code: string, termsVersion?: string) {
  await prisma.otpCode.create({ data: { phone, codeHash: sha256(code), expiresAt: new Date(Date.now() + 5 * 60_000) } });
  const res = await fetch(`${base}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code, termsVersion }),
  });
  expect(res.status).toBe(200);
  return prisma.user.findUniqueOrThrow({ where: { phone } });
}

describe('accepting the Terms and Privacy Policy at sign-in', () => {
  it('stores the version shown, and when', async () => {
    const user = await signIn('9199300001', '424242', TERMS_VERSION);
    expect(user.termsVersion).toBe(TERMS_VERSION);
    expect(user.termsAcceptedAt).not.toBeNull();
  });

  it('keeps the first acceptance time on later sign-ins of the same version', async () => {
    const first = await signIn('9199300002', '313131', TERMS_VERSION);
    const again = await signIn('9199300002', '313132', TERMS_VERSION);
    expect(again.termsAcceptedAt?.getTime()).toBe(first.termsAcceptedAt?.getTime());
  });

  it('records nothing for a stale or missing version', async () => {
    expect((await signIn('9199300003', '202020', '2020-01-01')).termsVersion).toBeNull();
    expect((await signIn('9199300004', '212121')).termsVersion).toBeNull();
  });
});
