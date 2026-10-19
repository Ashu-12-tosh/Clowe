import type { User } from '@prisma/client';
import {
  maskPhone,
  type AccountLookupResult,
  type AuthTokensResponse,
  type AuthUser,
  type LoginIdentifier,
  type OtpRequestResult,
  type PinResetRequestResult,
} from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { ApiError } from '../utils/ApiError';
import { generateOtpCode, generateReferralCode, generateRefreshToken, hashMatches, sha256 } from '../utils/crypto';
import { signAccessToken, signPhoneToken, verifyPhoneToken } from '../utils/jwt';
import { hashPin, verifyPin } from '../utils/pinHash';
import { OtpSendError, otpProvider } from './otp';

const OTP_RESEND_COOLDOWN_SEC = 45;
/** Codes one number can be sent in an hour, whoever asks for them: SMS costs money. */
export const OTP_SENDS_PER_HOUR = 6;
/**
 * How many still-valid codes a sign-in accepts: the latest and the two before
 * it, for an SMS that arrives after its resend. Few, so guessing stays as hard.
 */
const OTP_OPEN_CODES = 3;
/**
 * Wrong PINs since the last good one: every PIN_PAUSE_EVERY-th pauses PIN
 * sign-in (15 minutes, then 30), and from PIN_OTP_ONLY_AFTER only "Forgot
 * PIN?" — a code to the phone — opens it again: 15 guesses out of 10,000.
 * A correct PIN during a pause is refused with the pause, never as "wrong".
 */
export const PIN_PAUSE_EVERY = 5;
export const PIN_OTP_ONLY_AFTER = 15;
const PIN_PAUSE_MIN = 15;
/**
 * The one answer when the code could not be sent, whatever the reason. It
 * depends only on the SMS provider; the reason itself is in the API log.
 */
const OTP_SEND_FAILED = "We couldn't send the code. Please try again.";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    email: user.email,
    role: user.role,
    referralCode: user.referralCode,
    createdAt: user.createdAt.toISOString(),
    dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null,
    gender: (user.gender as AuthUser['gender']) ?? null,
    avatarUrl: user.avatarUrl,
    hasPin: !!user.pinHash,
    isPremium: user.isPremium,
    location: user.location,
    profession: user.profession,
    interests: user.interests,
    favouriteBrands: user.favouriteBrands,
    preferredCategories: user.preferredCategories,
    emailVerified: !!user.emailVerifiedAt,
    prefs: {
      email: user.notifyEmail,
      sms: user.notifySms,
      whatsapp: user.notifyWhatsapp,
      recommendations: user.personalizedRecs,
    },
  };
}

/**
 * Validate + consume the latest OTP for a phone (attempt-limited).
 * Used by login AND the phone-change flow.
 */
export async function consumeOtp(phone: string, code: string): Promise<void> {
  // Every code still valid, newest first. After "Resend" the earlier SMS can
  // still arrive — even after the new one — so any of them signs in; the
  // newest carries the wrong-attempt count, which a resend starts afresh.
  const open = await prisma.otpCode.findMany({
    where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: OTP_OPEN_CODES,
  });
  const newest = open[0];
  if (!newest) {
    throw ApiError.badRequest('OTP expired or not requested. Please request a new one.', 'OTP_INVALID');
  }
  if (newest.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw ApiError.tooMany('Too many wrong attempts. Please request a new OTP.', 'OTP_LOCKED');
  }
  if (!open.some((otp) => hashMatches(code, otp.codeHash))) {
    await prisma.otpCode.update({ where: { id: newest.id }, data: { attempts: { increment: 1 } } });
    throw ApiError.badRequest('Incorrect OTP', 'OTP_INCORRECT');
  }
  // One sign-in uses up every code sent for it.
  await prisma.otpCode.updateMany({
    where: { phone, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

async function issueTokens(user: User): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return { accessToken, refreshToken };
}

/** Create a user with a collision-safe referral code. */
async function createUser(phone: string, name?: string, referredById?: string, extra: { pinHash?: string } = {}): Promise<User> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.user.create({
        data: { phone, name: name ?? null, referralCode: generateReferralCode(), referredById, ...extra },
      });
    } catch (err: unknown) {
      // P2002 = unique violation; retry only for referralCode collisions.
      const code = (err as { code?: string }).code;
      const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? '');
      if (code === 'P2002' && target.includes('referralCode')) continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique referral code');
}

/** A referral code typed at sign-up: its owner, or nobody (sign-up never fails on it). */
async function referrerOf(code: string | undefined): Promise<User | null> {
  return code ? prisma.user.findUnique({ where: { referralCode: code } }) : null;
}

const NO_ACCOUNT = (id: LoginIdentifier) =>
  ApiError.notFound(`No account found with this ${id.kind === 'phone' ? 'number' : 'email'} — create one`, 'NO_ACCOUNT');

/**
 * The account a phone number or email signs in to. Emails are matched without
 * regard to case (they are stored lower-case, but older rows may not be); an
 * email on two accounts signs in to neither — the phone number decides.
 */
export async function findAccount(id: LoginIdentifier): Promise<User | null> {
  if (id.kind === 'phone') return prisma.user.findUnique({ where: { phone: id.value } });
  const rows = await prisma.user.findMany({ where: { email: { equals: id.value, mode: 'insensitive' } }, take: 2 });
  if (rows.length > 1) {
    throw ApiError.badRequest('This email is on more than one account — sign in with your mobile number', 'EMAIL_AMBIGUOUS');
  }
  return rows[0] ?? null;
}

/** Why PIN sign-in is closed right now, in words for the person — or null when it is open. */
function pinLockMessage(user: Pick<User, 'pinAttempts' | 'pinLockedUntil' | 'phone'>, now: Date): string | null {
  if (user.pinAttempts >= PIN_OTP_ONLY_AFTER) {
    return `Your PIN is locked after too many wrong tries. Tap “Forgot PIN?” to set a new one — we'll send a code to ${maskPhone(user.phone)}.`;
  }
  if (user.pinLockedUntil && user.pinLockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((user.pinLockedUntil.getTime() - now.getTime()) / 60_000));
    return `Too many wrong PINs. Try again in ${plural(minutes, 'minute')}, or tap “Forgot PIN?” to reset it by OTP.`;
  }
  return null;
}

export const authService = {
  /**
   * Generate an OTP, store its hash, deliver via the configured provider.
   * With the mock provider outside production, the OTP is also returned in the
   * response (devOtp) so the login page can show it. Never once a real SMS
   * provider is live: then the code exists only in the SMS.
   */
  async requestOtp(phone: string): Promise<OtpRequestResult> {
    const latest = await prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    if (latest) {
      const ageSec = (Date.now() - latest.createdAt.getTime()) / 1000;
      if (ageSec < OTP_RESEND_COOLDOWN_SEC) {
        throw ApiError.tooMany(
          `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SEC - ageSec)}s before requesting a new OTP`,
          'OTP_COOLDOWN',
        );
      }
    }
    // Per number, not per address: a script spread over many addresses still
    // cannot run up an SMS bill on one number, or flood its owner.
    const hourAgo = new Date(Date.now() - 3_600_000);
    const lastHour = await prisma.otpCode.findMany({
      where: { phone, createdAt: { gt: hourAgo } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (lastHour.length >= OTP_SENDS_PER_HOUR) {
      const minutes = Math.max(1, Math.ceil((lastHour[0]!.createdAt.getTime() + 3_600_000 - Date.now()) / 60_000));
      throw ApiError.tooMany(`Too many codes sent to this number. Try again in ${plural(minutes, 'minute')}.`, 'OTP_HOURLY_LIMIT');
    }

    const code = generateOtpCode();
    const otp = await prisma.otpCode.create({
      data: {
        phone,
        codeHash: sha256(code),
        expiresAt: new Date(Date.now() + env.OTP_TTL_MIN * 60 * 1000),
      },
    });
    try {
      await otpProvider.sendOtp(phone, code);
    } catch (err) {
      // The provider has logged why. Drop the unsent code so "try again" is not
      // met by the resend cooldown, and so it cannot be used.
      if (!(err instanceof OtpSendError)) {
        console.error(`[clowe-api] SMS OTP not sent: unexpected ${err instanceof Error ? err.name : typeof err}`);
      }
      await prisma.otpCode.delete({ where: { id: otp.id } });
      throw new ApiError(503, 'OTP_SEND_FAILED', OTP_SEND_FAILED);
    }
    const showCode = env.NODE_ENV !== 'production' && otpProvider.name === 'mock';
    return {
      resendAfterSec: OTP_RESEND_COOLDOWN_SEC,
      expiresInSec: env.OTP_TTL_MIN * 60,
      ...(showCode ? { devOtp: code } : {}),
    };
  },

  /**
   * Verify the OTP (seller login and older clients). Creates the account on
   * first login (with optional name and referral code), then issues tokens.
   */
  async verifyOtp(input: {
    phone: string;
    code: string;
    name?: string;
    referralCode?: string;
    purpose?: 'LOGIN' | 'PIN_RESET';
  }): Promise<AuthTokensResponse> {
    await consumeOtp(input.phone, input.code);

    let user = await prisma.user.findUnique({ where: { phone: input.phone } });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const referrer = await referrerOf(input.referralCode);
      user = await createUser(input.phone, input.name, referrer?.id);
      if (referrer) {
        await prisma.referral.create({
          data: { referrerId: referrer.id, referredUserId: user.id },
        });
      }
    }

    if (!user.isActive) {
      throw ApiError.forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');
    }

    // "Forgot PIN?" on older pages: the code proves the phone, so from this
    // moment the old PIN is gone, the lockout is cleared, and every session
    // signed in until now is signed out. (The login page now sends the code
    // and the new PIN together — pin-reset/confirm — so nothing is half done.)
    if (input.purpose === 'PIN_RESET' && !isNewUser) {
      const now = new Date();
      [user] = await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { pinHash: null, pinAttempts: 0, pinLockedUntil: null } }),
        prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } }),
      ]);
      const tokens = await issueTokens(user);
      return { user: toAuthUser(user), ...tokens, isNewUser, pinResetRequired: true };
    }

    // A successful OTP login clears any PIN lockout.
    if (user.pinAttempts > 0 || user.pinLockedUntil) {
      await prisma.user.update({ where: { id: user.id }, data: { pinAttempts: 0, pinLockedUntil: null } });
    }

    const tokens = await issueTokens(user);
    return { user: toAuthUser(user), ...tokens, isNewUser };
  },

  /** Is there an account for this number or email, and does it have a PIN? */
  async lookup(id: LoginIdentifier): Promise<AccountLookupResult> {
    const user = await findAccount(id);
    return {
      exists: !!user,
      kind: id.kind,
      identifier: id.value,
      hasPin: !!user?.pinHash,
      phoneMasked: user ? maskPhone(user.phone) : null,
    };
  },

  /**
   * Sign in with the 4-digit PIN, by phone number or email.
   *
   * Each answer says what happened — no account, no PIN yet, paused after
   * wrong tries (with how long), or wrong with tries left — because "that PIN
   * is wrong" for a correct PIN on a paused account is exactly the confusion
   * this replaced. Whether an account is deactivated is told only to someone
   * who got its PIN right. Tries on one account are taken one at a time.
   */
  async pinLogin(id: LoginIdentifier, pin: string): Promise<AuthTokensResponse> {
    const found = await findAccount(id);
    if (!found) throw NO_ACCOUNT(id);
    if (!found.pinHash) {
      throw ApiError.badRequest('You haven’t set a PIN yet. Tap “Forgot PIN?” to set one — we’ll send a code to your phone.', 'PIN_NOT_SET');
    }

    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pin-login:${found.id}`}))`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: found.id } });
        const now = new Date();
        const locked = pinLockMessage(user, now);
        if (locked) return { kind: 'locked' as const, message: locked };

        const check = await verifyPin(user.id, pin, user.pinHash!);
        if (!check.ok) {
          const attempts = user.pinAttempts + 1;
          const pauses = attempts % PIN_PAUSE_EVERY === 0 && attempts < PIN_OTP_ONLY_AFTER;
          // 15 minutes at the 5th wrong PIN, 30 at the 10th; the 15th needs "Forgot PIN?".
          const pauseMs = PIN_PAUSE_MIN * 60_000 * 2 ** (attempts / PIN_PAUSE_EVERY - 1);
          const until = pauses ? new Date(now.getTime() + pauseMs) : user.pinLockedUntil;
          const updated = await tx.user.update({ where: { id: user.id }, data: { pinAttempts: attempts, pinLockedUntil: until } });
          const nowLocked = pinLockMessage(updated, now);
          if (nowLocked) return { kind: 'locked' as const, message: nowLocked };
          const left = PIN_PAUSE_EVERY - (attempts % PIN_PAUSE_EVERY);
          return { kind: 'wrong' as const, message: `Wrong PIN. ${left === 1 ? '1 try' : `${left} tries`} left before a short pause — or tap “Forgot PIN?”.` };
        }
        // Right PIN. An older hash is replaced by the current kind as it is used.
        const user2 = await tx.user.update({
          where: { id: user.id },
          data: { pinAttempts: 0, pinLockedUntil: null, ...(check.legacy ? { pinHash: await hashPin(pin) } : {}) },
        });
        return { kind: 'ok' as const, user: user2 };
      },
      { timeout: 15_000 },
    );
    if (outcome.kind === 'locked') throw ApiError.tooMany(outcome.message, 'PIN_LOCKED');
    if (outcome.kind === 'wrong') throw ApiError.badRequest(outcome.message, 'PIN_INVALID');
    if (!outcome.user.isActive) {
      throw ApiError.forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');
    }
    const tokens = await issueTokens(outcome.user);
    return { user: toAuthUser(outcome.user), ...tokens };
  },

  /** Set (or replace) the quick-login PIN for the authenticated user. */
  async setPin(userId: string, pin: string): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { pinHash: await hashPin(pin), pinAttempts: 0, pinLockedUntil: null },
    });
  },

  /** "Forgot PIN?" (or setting a first PIN): a code to the account's own phone. */
  async requestPinReset(id: LoginIdentifier): Promise<PinResetRequestResult> {
    const user = await findAccount(id);
    if (!user) throw NO_ACCOUNT(id);
    return { ...(await authService.requestOtp(user.phone)), phoneMasked: maskPhone(user.phone) };
  },

  /**
   * The code and the new PIN together, in one step: the old PIN works until
   * the new one is saved, so a page closed halfway leaves nothing broken. The
   * lockout clears and every other session is signed out; this one stays.
   */
  async confirmPinReset(id: LoginIdentifier, code: string, pin: string): Promise<AuthTokensResponse> {
    const found = await findAccount(id);
    if (!found) throw NO_ACCOUNT(id);
    await consumeOtp(found.phone, code);
    if (!found.isActive) throw ApiError.forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');
    const pinHash = await hashPin(pin);
    const [user] = await prisma.$transaction([
      prisma.user.update({ where: { id: found.id }, data: { pinHash, pinAttempts: 0, pinLockedUntil: null } }),
      prisma.refreshToken.updateMany({ where: { userId: found.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    const tokens = await issueTokens(user);
    return { user: toAuthUser(user), ...tokens };
  },

  /** Sign-up's "Verify" beside the phone: the code is checked here, once. */
  async verifySignupPhone(phone: string, code: string): Promise<{ phoneToken: string }> {
    if (await prisma.user.findUnique({ where: { phone }, select: { id: true } })) {
      throw new ApiError(409, 'PHONE_TAKEN', 'This number already has an account — log in instead');
    }
    await consumeOtp(phone, code);
    return { phoneToken: signPhoneToken(phone) };
  },

  /** "Create account": a verified phone, a name, an optional email and a PIN. */
  async signup(input: {
    name: string;
    phone: string;
    phoneToken: string;
    email?: string;
    pin: string;
    referralCode?: string;
  }): Promise<AuthTokensResponse & { email: string | null }> {
    if (!verifyPhoneToken(input.phoneToken, input.phone)) {
      throw ApiError.badRequest('Verify your phone number again — the code has expired', 'PHONE_NOT_VERIFIED');
    }
    if (await prisma.user.findUnique({ where: { phone: input.phone }, select: { id: true } })) {
      throw new ApiError(409, 'PHONE_TAKEN', 'This number already has an account — log in instead');
    }
    const email = input.email || null;
    if (email && (await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } }))) {
      throw new ApiError(409, 'EMAIL_TAKEN', 'This email is already on another account — use another, or leave it empty');
    }
    const referrer = await referrerOf(input.referralCode);
    const user = await createUser(input.phone, input.name, referrer?.id, { pinHash: await hashPin(input.pin) });
    if (referrer) await prisma.referral.create({ data: { referrerId: referrer.id, referredUserId: user.id } });
    const tokens = await issueTokens(user);
    return { user: toAuthUser(user), ...tokens, isNewUser: true, email };
  },

  /** Rotate a refresh token: revoke the old one, issue a fresh pair. */
  async refresh(refreshToken: string): Promise<AuthTokensResponse> {
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw ApiError.unauthorized('Invalid or expired refresh token', 'REFRESH_INVALID');
    }
    if (!stored.user.isActive) {
      throw ApiError.forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');
    }
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const tokens = await issueTokens(stored.user);
    return { user: toAuthUser(stored.user), ...tokens };
  },

  /** Revoke one refresh token (logout on this device). */
  async logout(refreshToken: string): Promise<void> {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async getMe(userId: string): Promise<AuthUser> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.unauthorized();
    return toAuthUser(user);
  },
};
