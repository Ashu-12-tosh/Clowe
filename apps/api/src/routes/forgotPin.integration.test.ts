import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { authService, PIN_OTP_ONLY_AFTER } from '../services/authService';
import { sha256 } from '../utils/crypto';

/**
 * "Forgot PIN?". Verifying the OTP with purpose PIN_RESET removes the old PIN
 * at once, clears the lockout and signs out every other session; the answer
 * says a new PIN must be set. A page closed before that leaves no PIN, so the
 * next login is by OTP. Without the purpose, an OTP login leaves the PIN be.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

interface Body {
  data: { accessToken: string; refreshToken: string; pinResetRequired?: boolean; hasPin?: boolean; user: { hasPin: boolean } };
  error?: { code: string; message: string };
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

/** A user with PIN 1234 and two signed-in devices; optionally locked out. */
async function userWithPin(phone: string, locked = false) {
  const user = await prisma.user.create({ data: { phone, name: 'Pin Person', referralCode: `PIN-${phone.slice(-4)}` } });
  await authService.setPin(user.id, '1234');
  // Locked: past the wrong tries after which only "Forgot PIN?" opens it.
  if (locked) await prisma.user.update({ where: { id: user.id }, data: { pinAttempts: PIN_OTP_ONLY_AFTER } });
  const devices = [await authService.pinLogin({ kind: 'phone', value: phone }, '1234').catch(() => null), null];
  // A locked-out user cannot PIN-login; sign two devices in by OTP instead.
  for (let i = 0; i < 2; i++) {
    if (devices[i]) continue;
    await code(phone, `55555${i}`);
    devices[i] = await authService.verifyOtp({ phone, code: `55555${i}` });
  }
  return { user, devices: devices as NonNullable<(typeof devices)[number]>[] };
}

/** An OTP as if sent (the resend cooldown blocks real back-to-back sends). */
async function code(phone: string, value: string) {
  await prisma.otpCode.create({ data: { phone, codeHash: sha256(value), expiresAt: new Date(Date.now() + 5 * 60_000) } });
}

beforeAll(() => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('Forgot PIN', () => {
  it('verifying the OTP removes the old PIN, clears the lockout, signs out other sessions, and asks for a new PIN', async () => {
    const { user, devices } = await userWithPin('9199200001', true);
    await code('9199200001', '246810');
    const r = await post('/api/auth/verify-otp', { phone: '9199200001', code: '246810', purpose: 'PIN_RESET' });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ pinResetRequired: true, user: { hasPin: false } });

    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pinHash: null, pinAttempts: 0 });
    // Both devices signed in before are out; the new session works.
    for (const d of devices) expect((await post('/api/auth/refresh', { refreshToken: d.refreshToken })).status).toBe(401);
    expect((await post('/api/auth/refresh', { refreshToken: r.json.data.refreshToken })).status).toBe(200);
  });

  it('leaves the old PIN refused, saying no PIN is set (not that it is wrong)', async () => {
    await userWithPin('9199200002');
    await code('9199200002', '135791');
    await post('/api/auth/verify-otp', { phone: '9199200002', code: '135791', purpose: 'PIN_RESET' });
    const old = await post('/api/auth/pin-login', { phone: '9199200002', pin: '1234' });
    expect(old.status).toBe(400);
    expect(old.json.error?.code).toBe('PIN_NOT_SET');
  });

  it('closed midway: no PIN works, and the next login is by OTP (without asking for a reset again)', async () => {
    await userWithPin('9199200003');
    await code('9199200003', '111222');
    await post('/api/auth/verify-otp', { phone: '9199200003', code: '111222', purpose: 'PIN_RESET' });
    // The page was closed here: no new PIN was set.
    expect((await post('/api/auth/pin-login', { phone: '9199200003', pin: '1234' })).status).toBe(400);
    await code('9199200003', '333444');
    const next = await post('/api/auth/verify-otp', { phone: '9199200003', code: '333444' });
    expect(next.status).toBe(200);
    expect(next.json.data.user.hasPin).toBe(false);
    expect(next.json.data.pinResetRequired).toBeUndefined();
  });

  it('the new PIN, entered twice, works; the old one does not; a mismatch is refused', async () => {
    await userWithPin('9199200004');
    await code('9199200004', '999000');
    const r = await post('/api/auth/verify-otp', { phone: '9199200004', code: '999000', purpose: 'PIN_RESET' });
    const token = r.json.data.accessToken;
    const mismatch = await post('/api/auth/me/set-pin', { pin: '5678', confirmPin: '5679' }, token);
    expect(mismatch.status).toBe(400);
    const set = await post('/api/auth/me/set-pin', { pin: '5678', confirmPin: '5678' }, token);
    expect(set.status).toBe(200);
    expect(set.json.data.hasPin).toBe(true);
    expect((await post('/api/auth/pin-login', { phone: '9199200004', pin: '5678' })).status).toBe(200);
    expect((await post('/api/auth/pin-login', { phone: '9199200004', pin: '1234' })).status).toBe(400);
  });

  it('an ordinary OTP login leaves the PIN and the other sessions alone', async () => {
    const { devices } = await userWithPin('9199200005');
    await code('9199200005', '424242');
    const r = await post('/api/auth/verify-otp', { phone: '9199200005', code: '424242' });
    expect(r.json.data.user.hasPin).toBe(true);
    expect((await post('/api/auth/pin-login', { phone: '9199200005', pin: '1234' })).status).toBe(200);
    expect((await post('/api/auth/refresh', { refreshToken: devices[1]!.refreshToken })).status).toBe(200);
  });

  it('a wrong code changes nothing', async () => {
    const { user } = await userWithPin('9199200006');
    await code('9199200006', '777888');
    const r = await post('/api/auth/verify-otp', { phone: '9199200006', code: '000000', purpose: 'PIN_RESET' });
    expect(r.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pinHash).not.toBeNull();
  });
});
