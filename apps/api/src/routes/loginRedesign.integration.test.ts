import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { env } from '../env';
import { ACCOUNT_LOOKUP_LIMIT } from '../middleware/rateLimits';
import { authService, OTP_SENDS_PER_HOUR, PIN_OTP_ONLY_AFTER, PIN_PAUSE_EVERY } from '../services/authService';
import { sha256 } from '../utils/crypto';

/**
 * The login page redesign and the "correct PIN shown as wrong" bug
 * (pre-launch audit 2026-10-20, D1 and D2).
 *
 * D1: one box ("Phone number or email") → is there an account? → PIN with
 * "Forgot PIN?" (a code to the phone, then the new PIN, in one step), or the
 * Create account form (name, phone verified by OTP, email, PIN twice). The
 * lookup, the codes and the PIN tries are all limited.
 *
 * D2, each cause with its own test:
 *  - a pause after wrong PINs answered a correct PIN as "wrong", and never ended
 *  - "+91 98765 43210" / "919876543210" became another (valid) number
 *  - an email typed in another case, or with spaces, matched no account
 *  - "Forgot PIN?" removed the PIN before the new one was saved
 *  - the PIN hash depended on the JWT secret, so rotating it broke every PIN
 *  - a PIN with a leading zero, or pasted with a space
 *  - wrong tries arriving together counted past the limit
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;

interface Json {
  data: Record<string, unknown> & { accessToken?: string; refreshToken?: string; user?: { id: string; phone: string; email: string | null; hasPin: boolean } };
  error?: { code: string; message: string };
}

/** Each test sends from its own address, so the per-address limits don't meet. */
function client() {
  seq += 1;
  const ip = `10.77.${Math.floor(seq / 250)}.${(seq % 250) + 1}`;
  return async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Json };
  };
}

let phoneSeq = 0;
const nextPhone = () => `91930${String(++phoneSeq).padStart(5, '0')}`;

async function account(opts: { pin?: string; email?: string; phone?: string } = {}) {
  const phone = opts.phone ?? nextPhone();
  const user = await prisma.user.create({ data: { phone, name: 'Login Person', email: opts.email ?? null, referralCode: `LGN-${phone.slice(-5)}` } });
  if (opts.pin) await authService.setPin(user.id, opts.pin);
  return { id: user.id, phone };
}

/** An OTP as if sent (the resend cooldown blocks real back-to-back sends). */
async function otp(phone: string, value: string) {
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

describe('account lookup', () => {
  it('finds the account by number in any written form, or by email in any case', async () => {
    const post = client();
    const a = await account({ pin: '4321', email: 'lookup.person@example.com' });
    for (const typed of [a.phone, `+91 ${a.phone.slice(0, 5)} ${a.phone.slice(5)}`, `91${a.phone}`, `0${a.phone}`]) {
      const r = await post('/api/auth/lookup', { identifier: typed });
      expect(r.json.data, typed).toMatchObject({ exists: true, kind: 'phone', identifier: a.phone, hasPin: true });
    }
    const byEmail = await post('/api/auth/lookup', { identifier: '  Lookup.Person@EXAMPLE.com ' });
    expect(byEmail.json.data).toMatchObject({ exists: true, kind: 'email', identifier: 'lookup.person@example.com', hasPin: true });
    expect(byEmail.json.data.phoneMasked).toBe(`+91 ${a.phone.slice(0, 2)}XXX XX${a.phone.slice(7)}`);
  });

  it('says when there is no account, and refuses what is neither a number nor an email', async () => {
    const post = client();
    expect((await post('/api/auth/lookup', { identifier: nextPhone() })).json.data).toMatchObject({ exists: false, hasPin: false, phoneMasked: null });
    expect((await post('/api/auth/lookup', { identifier: 'nobody.here@example.com' })).json.data).toMatchObject({ exists: false });
    expect((await post('/api/auth/lookup', { identifier: '12345' })).status).toBe(400);
  });

  it('is rate-limited per address', async () => {
    const post = client();
    for (let i = 0; i < ACCOUNT_LOOKUP_LIMIT; i++) expect((await post('/api/auth/lookup', { identifier: nextPhone() })).status).toBe(200);
    const over = await post('/api/auth/lookup', { identifier: nextPhone() });
    expect(over.status).toBe(429);
    expect(over.json.error?.message).toMatch(/try again in 15 minutes/i);
  });
});

describe('create account', () => {
  it('needs the phone verified by OTP, then creates the account with its PIN; login works by phone or email', async () => {
    const post = client();
    const phone = nextPhone();
    const sent = await post('/api/auth/request-otp', { phone: `+91 ${phone}` });
    expect(sent.status).toBe(200);
    const devOtp = sent.json.data.devOtp as string;

    const form = { name: 'Asha Rao', phone, email: ' Asha.Signup@Example.COM ', pin: '0123', confirmPin: '0123', termsVersion: undefined };
    // Without a verified phone, nothing is created.
    expect((await post('/api/auth/signup', { ...form, phoneToken: 'x'.repeat(40) })).json.error?.code).toBe('PHONE_NOT_VERIFIED');
    expect((await post('/api/auth/signup/verify-phone', { phone, code: '000000' })).json.error?.code).toBe('OTP_INCORRECT');
    const verified = await post('/api/auth/signup/verify-phone', { phone, code: devOtp });
    expect(verified.status, JSON.stringify(verified.json)).toBe(200);
    const phoneToken = verified.json.data.phoneToken as string;

    // The proof is for this number only, and the PINs must match.
    expect((await post('/api/auth/signup', { ...form, phone: nextPhone(), phoneToken })).json.error?.code).toBe('PHONE_NOT_VERIFIED');
    expect((await post('/api/auth/signup', { ...form, confirmPin: '0124', phoneToken })).status).toBe(400);

    const created = await post('/api/auth/signup', { ...form, phoneToken });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json.data).toMatchObject({ isNewUser: true, user: { phone, email: 'asha.signup@example.com', hasPin: true } });
    expect((await prisma.user.findUniqueOrThrow({ where: { phone } })).pinHash).toMatch(/^scrypt1\$/);

    // Same normalisation at login: the email in another case, the number with +91.
    expect((await post('/api/auth/pin-login', { identifier: 'ASHA.SIGNUP@example.com ', pin: '0123' })).status).toBe(200);
    expect((await post('/api/auth/pin-login', { identifier: `+91 ${phone}`, pin: '0123' })).status).toBe(200);
    // A number that already has an account cannot sign up again.
    expect((await post('/api/auth/signup', { ...form, phoneToken })).json.error?.code).toBe('PHONE_TAKEN');
  });

  it('refuses an email that is already on another account', async () => {
    const post = client();
    await account({ email: 'taken.signup@example.com' });
    const phone = nextPhone();
    await otp(phone, '112233');
    const { phoneToken } = (await post('/api/auth/signup/verify-phone', { phone, code: '112233' })).json.data as { phoneToken: string };
    const r = await post('/api/auth/signup', { name: 'Second', phone, phoneToken, email: 'Taken.Signup@example.com', pin: '1111', confirmPin: '1111' });
    expect(r.json.error?.code).toBe('EMAIL_TAKEN');
    expect(await prisma.user.findUnique({ where: { phone } })).toBeNull();
  });

  it('a phone that has an account is told to log in at Verify, before any code is used', async () => {
    const post = client();
    const a = await account();
    await otp(a.phone, '445566');
    expect((await post('/api/auth/signup/verify-phone', { phone: a.phone, code: '445566' })).json.error?.code).toBe('PHONE_TAKEN');
  });
});

describe('D2: a correct PIN is never answered as wrong', () => {
  it('a pause after wrong PINs says so, refuses even the right PIN with that message, and ends', async () => {
    const post = client();
    const a = await account({ pin: '2580' });
    for (let i = 1; i < PIN_PAUSE_EVERY; i++) {
      const r = await post('/api/auth/pin-login', { identifier: a.phone, pin: '0000' });
      expect(r.json.error?.code).toBe('PIN_INVALID');
      expect(r.json.error?.message).toMatch(new RegExp(`${PIN_PAUSE_EVERY - i} tr(y|ies) left`));
    }
    const fifth = await post('/api/auth/pin-login', { identifier: a.phone, pin: '0000' });
    expect(fifth.status).toBe(429);
    expect(fifth.json.error).toMatchObject({ code: 'PIN_LOCKED', message: expect.stringMatching(/Try again in 15 minutes/) });
    // The right PIN, during the pause: the pause, not "wrong".
    const right = await post('/api/auth/pin-login', { identifier: a.phone, pin: '2580' });
    expect(right.json.error?.code).toBe('PIN_LOCKED');
    // The pause ends (it used to be for ever, and silent).
    await prisma.user.update({ where: { id: a.id }, data: { pinLockedUntil: new Date(Date.now() - 1000) } });
    expect((await post('/api/auth/pin-login', { identifier: a.phone, pin: '2580' })).status).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ pinAttempts: 0, pinLockedUntil: null });
  });

  it('after 15 wrong PINs only "Forgot PIN?" opens it, and says so', async () => {
    const post = client();
    const a = await account({ pin: '2580' });
    await prisma.user.update({ where: { id: a.id }, data: { pinAttempts: PIN_OTP_ONLY_AFTER - 1 } });
    const last = await post('/api/auth/pin-login', { identifier: a.phone, pin: '0000' });
    expect(last.json.error).toMatchObject({ code: 'PIN_LOCKED', message: expect.stringMatching(/Forgot PIN/) });
    await prisma.user.update({ where: { id: a.id }, data: { pinLockedUntil: null } });
    expect((await post('/api/auth/pin-login', { identifier: a.phone, pin: '2580' })).json.error?.code).toBe('PIN_LOCKED');
  });

  it('counts wrong tries that arrive together one by one, never past the pause', async () => {
    const post = client();
    const a = await account({ pin: '2580' });
    const answers = await Promise.all(Array.from({ length: 10 }, () => post('/api/auth/pin-login', { identifier: a.phone, pin: '0000' })));
    expect(answers.filter((r) => r.json.error?.code === 'PIN_INVALID')).toHaveLength(PIN_PAUSE_EVERY - 1);
    expect(answers.filter((r) => r.json.error?.code === 'PIN_LOCKED')).toHaveLength(10 - (PIN_PAUSE_EVERY - 1));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).pinAttempts).toBe(PIN_PAUSE_EVERY);
  });

  it('"919876543210" signs in to 9876543210 — not to 9198765432, a different account', async () => {
    const post = client();
    const mine = await account({ pin: '1111', phone: '9876543210' });
    await account({ pin: '2222', phone: '9198765432' });
    const r = await post('/api/auth/pin-login', { identifier: '919876543210', pin: '1111' });
    expect(r.status).toBe(200);
    expect(r.json.data.user?.id).toBe(mine.id);
  });

  it('keeps a leading zero, and ignores a space a paste added', async () => {
    const post = client();
    const a = await account({ pin: '0007' });
    expect((await post('/api/auth/pin-login', { identifier: a.phone, pin: ' 0007' })).status).toBe(200);
    expect((await post('/api/auth/pin-login', { identifier: a.phone, pin: 7 })).status).toBe(400);
  });

  it('an older PIN hash still signs in, and is replaced by one that does not depend on the JWT secret', async () => {
    const post = client();
    const a = await account();
    const legacy = createHash('sha256').update(`${a.id}:1357:${env.JWT_ACCESS_SECRET}`).digest('hex');
    await prisma.user.update({ where: { id: a.id }, data: { pinHash: legacy } });
    expect((await post('/api/auth/pin-login', { identifier: a.phone, pin: '1357' })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).pinHash).toMatch(/^scrypt1\$/);

    const was = env.JWT_ACCESS_SECRET;
    (env as { JWT_ACCESS_SECRET: string }).JWT_ACCESS_SECRET = `${was}-rotated`;
    try {
      expect(await authService.pinLogin({ kind: 'phone', value: a.phone }, '1357')).toMatchObject({ user: { id: a.id } });
    } finally {
      (env as { JWT_ACCESS_SECRET: string }).JWT_ACCESS_SECRET = was;
    }
  });

  it('an email on two accounts (older rows, different case) signs in to neither: the phone decides', async () => {
    const post = client();
    await account({ pin: '1111', email: 'Twice@Example.com' });
    await account({ pin: '1111', email: 'twice@example.com' });
    expect((await post('/api/auth/pin-login', { identifier: 'twice@example.com', pin: '1111' })).json.error?.code).toBe('EMAIL_AMBIGUOUS');
  });

  it('says there is no account, or no PIN yet, instead of "wrong PIN"', async () => {
    const post = client();
    expect((await post('/api/auth/pin-login', { identifier: nextPhone(), pin: '1111' })).json.error?.code).toBe('NO_ACCOUNT');
    const noPin = await account();
    expect((await post('/api/auth/pin-login', { identifier: noPin.phone, pin: '1111' })).json.error?.code).toBe('PIN_NOT_SET');
  });
});

describe('Forgot PIN, in one step', () => {
  it('the old PIN works until the code and the new PIN are sent together; then only the new one does', async () => {
    const post = client();
    const a = await account({ pin: '1234', email: 'forgot.one@example.com' });
    const other = await authService.pinLogin({ kind: 'phone', value: a.phone }, '1234');
    await prisma.user.update({ where: { id: a.id }, data: { pinAttempts: PIN_OTP_ONLY_AFTER } });

    const sent = await post('/api/auth/pin-reset/request', { identifier: 'Forgot.One@example.com' });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json.data.phoneMasked).toBe(`+91 ${a.phone.slice(0, 2)}XXX XX${a.phone.slice(7)}`);
    // Asked for, not used: the PIN is untouched (a page closed here breaks nothing).
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).pinHash).not.toBeNull();

    const code = sent.json.data.devOtp as string;
    expect((await post('/api/auth/pin-reset/confirm', { identifier: a.phone, code, pin: '5678', confirmPin: '5679' })).status).toBe(400);
    const done = await post('/api/auth/pin-reset/confirm', { identifier: a.phone, code, pin: '5678', confirmPin: '5678' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ pinAttempts: 0, pinLockedUntil: null });

    expect((await post('/api/auth/pin-login', { identifier: a.phone, pin: '5678' })).status).toBe(200);
    expect((await post('/api/auth/pin-login', { identifier: a.phone, pin: '1234' })).json.error?.code).toBe('PIN_INVALID');
    // Signed out elsewhere; the reset's own session stays.
    expect((await post('/api/auth/refresh', { refreshToken: other.refreshToken })).status).toBe(401);
    expect((await post('/api/auth/refresh', { refreshToken: done.json.data.refreshToken })).status).toBe(200);
  });

  it('sets a first PIN for an account that never had one', async () => {
    const post = client();
    const a = await account();
    await otp(a.phone, '909090');
    expect((await post('/api/auth/pin-reset/confirm', { identifier: a.phone, code: '909090', pin: '4444', confirmPin: '4444' })).status).toBe(200);
    expect((await post('/api/auth/pin-login', { identifier: a.phone, pin: '4444' })).status).toBe(200);
  });

  it('a wrong code changes nothing', async () => {
    const post = client();
    const a = await account({ pin: '1234' });
    await otp(a.phone, '121212');
    expect((await post('/api/auth/pin-reset/confirm', { identifier: a.phone, code: '000000', pin: '9999', confirmPin: '9999' })).json.error?.code).toBe('OTP_INCORRECT');
    expect((await post('/api/auth/pin-login', { identifier: a.phone, pin: '1234' })).status).toBe(200);
  });

  it('no account: says so', async () => {
    const post = client();
    expect((await post('/api/auth/pin-reset/request', { identifier: nextPhone() })).json.error?.code).toBe('NO_ACCOUNT');
  });
});

describe('OTP sends', () => {
  it('one number gets at most a few codes an hour, from any number of addresses', async () => {
    const phone = nextPhone();
    for (let i = 0; i < OTP_SENDS_PER_HOUR; i++) {
      const post = client();
      expect((await post('/api/auth/request-otp', { phone })).status, `send ${i + 1}`).toBe(200);
      // Past the 45-second resend wait, as if time had passed.
      await prisma.otpCode.updateMany({ where: { phone }, data: { createdAt: new Date(Date.now() - (OTP_SENDS_PER_HOUR - i) * 60_000) } });
    }
    const over = await client()('/api/auth/request-otp', { phone });
    expect(over.status).toBe(429);
    expect(over.json.error).toMatchObject({ code: 'OTP_HOURLY_LIMIT', message: expect.stringMatching(/Try again in \d+ minutes?/) });
  });
});
