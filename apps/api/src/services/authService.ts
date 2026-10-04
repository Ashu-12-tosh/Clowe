import type { User } from '@prisma/client';
import type { AuthTokensResponse, AuthUser } from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { ApiError } from '../utils/ApiError';
import {
  generateOtpCode,
  generateReferralCode,
  generateRefreshToken,
  hashMatches,
  sha256,
} from '../utils/crypto';
import { signAccessToken } from '../utils/jwt';
import { OtpSendError, otpProvider } from './otp';

const OTP_RESEND_COOLDOWN_SEC = 45;
const PIN_MAX_ATTEMPTS = 5;
/** The one answer to a failed PIN login, whatever the reason. */
const PIN_LOGIN_FAILED = "That number and PIN don't match. Use OTP if you've forgotten your PIN.";
/**
 * The one answer when the code could not be sent, whatever the reason. It
 * depends only on the SMS provider, never on whether the number has an
 * account; the reason itself is in the API log.
 */
const OTP_SEND_FAILED = "We couldn't send the code. Please try again.";
/** Compared against when a number has no PIN, so the work is the same either way. */
const NO_PIN_HASH = sha256('no-pin-set');

/** PIN is peppered + scoped to the user before hashing (never stored raw). */
function pinPlain(userId: string, pin: string): string {
  return `${userId}:${pin}:${env.JWT_ACCESS_SECRET}`;
}

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
  const otp = await prisma.otpCode.findFirst({
    where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) {
    throw ApiError.badRequest('OTP expired or not requested. Please request a new one.', 'OTP_INVALID');
  }
  if (otp.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw ApiError.tooMany('Too many wrong attempts. Please request a new OTP.', 'OTP_LOCKED');
  }
  if (!hashMatches(code, otp.codeHash)) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw ApiError.badRequest('Incorrect OTP', 'OTP_INCORRECT');
  }
  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
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
async function createUser(phone: string, name?: string, referredById?: string): Promise<User> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.user.create({
        data: { phone, name: name ?? null, referralCode: generateReferralCode(), referredById },
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

export const authService = {
  /**
   * Step 1: generate an OTP, store its hash, deliver via the configured provider.
   * With the mock provider outside production, the OTP is also returned in the
   * response (devOtp) so the login page can show it. Never once a real SMS
   * provider is live: then the code exists only in the SMS.
   */
  async requestOtp(phone: string): Promise<{ resendAfterSec: number; devOtp?: string }> {
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
      ...(showCode ? { devOtp: code } : {}),
    };
  },

  /**
   * Step 2: verify the OTP. Creates the account on first login (with optional
   * name and referral code), then issues access + refresh tokens.
   */
  async verifyOtp(input: {
    phone: string;
    code: string;
    name?: string;
    referralCode?: string;
  }): Promise<AuthTokensResponse> {
    await consumeOtp(input.phone, input.code);

    let user = await prisma.user.findUnique({ where: { phone: input.phone } });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      // Resolve referral code (ignored silently if invalid — signup must not fail on it).
      let referrer: User | null = null;
      if (input.referralCode) {
        referrer = await prisma.user.findUnique({ where: { referralCode: input.referralCode } });
      }
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

    // A successful OTP login clears any PIN lockout.
    if (user.pinAttempts > 0) {
      await prisma.user.update({ where: { id: user.id }, data: { pinAttempts: 0 } });
    }

    const tokens = await issueTokens(user);
    return { user: toAuthUser(user), ...tokens, isNewUser };
  },

  /**
   * Quick login with the 4-digit PIN (5 attempts, then OTP-only).
   *
   * Every failure looks the same — no such number, no PIN set, locked out,
   * wrong PIN — down to the work done for it, so the answer says nothing
   * about which numbers have accounts. Whether an account is deactivated is
   * told only to someone who got its PIN right.
   */
  async pinLogin(phone: string, pin: string): Promise<AuthTokensResponse> {
    const user = await prisma.user.findUnique({ where: { phone } });
    const ok =
      hashMatches(pinPlain(user?.id ?? 'no-account', pin), user?.pinHash ?? NO_PIN_HASH) &&
      !!user?.pinHash &&
      user.pinAttempts < PIN_MAX_ATTEMPTS;
    if (!ok || !user) {
      // The same write whatever went wrong: counts a real PIN's failed try,
      // and matches nothing for a number without one.
      await prisma.user.updateMany({
        where: { phone, pinHash: { not: null } },
        data: { pinAttempts: { increment: 1 } },
      });
      throw ApiError.badRequest(PIN_LOGIN_FAILED, 'PIN_INVALID');
    }
    if (!user.isActive) {
      throw ApiError.forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');
    }
    await prisma.user.update({ where: { id: user.id }, data: { pinAttempts: 0 } });
    const tokens = await issueTokens(user);
    return { user: toAuthUser(user), ...tokens };
  },

  /** Set (or replace) the quick-login PIN for the authenticated user. */
  async setPin(userId: string, pin: string): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { pinHash: sha256(pinPlain(userId, pin)), pinAttempts: 0 },
    });
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
