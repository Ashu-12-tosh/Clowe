import { Router, type Response } from 'express';
import { env } from '../env';
import {
  deleteAccountSchema,
  type SecurityOverview,
  type SessionInfo,
  checkPhoneSchema,
  phoneChangeConfirmSchema,
  phoneChangeRequestSchema,
  pinLoginSchema,
  requestOtpSchema,
  setPinSchema,
  verifyOtpSchema,
  refreshTokenSchema,
  updatePreferencesSchema,
  updateProfileSchema,
} from '@clowe/shared';
import { prisma } from '../db';
import { consumeOtp } from '../services/authService';
import { ApiError } from '../utils/ApiError';
import { authService } from '../services/authService';
import { auditLogin } from '../services/auditService';
import { requireAuth } from '../middleware/auth';
import { otpRequestLimiter, otpVerifyLimiter } from '../middleware/rateLimits';

export const authRouter = Router();

// --- Refresh-token cookie: httpOnly + secure (prod) + scoped to auth routes ---
const REFRESH_COOKIE = 'clowe_refresh';

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth', // only sent to auth endpoints
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
}

/** Cookie first; body fallback for older sessions / the future mobile app. */
function refreshTokenFrom(req: { cookies?: Record<string, string>; body?: unknown }): string | undefined {
  const { refreshToken } = refreshTokenSchema.parse(req.body ?? {});
  return req.cookies?.[REFRESH_COOKIE] ?? refreshToken;
}

// Pre-login lookup: does this account exist and have a quick-login PIN?
// Drives the login page's PIN-vs-OTP branch.
authRouter.post('/check-phone', async (req, res, next) => {
  try {
    const { phone } = checkPhoneSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { phone },
      select: { pinHash: true, pinAttempts: true, isActive: true },
    });
    res.json({
      success: true,
      data: {
        exists: !!user && user.isActive,
        // Locked PINs route straight to OTP.
        hasPin: !!user?.pinHash && user.pinAttempts < 5,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Quick login with the 4-digit PIN (no OTP/SMS cost).
authRouter.post('/pin-login', otpVerifyLimiter, async (req, res, next) => {
  const { phone } = req.body ?? {};
  try {
    const input = pinLoginSchema.parse(req.body);
    const data = await authService.pinLogin(input.phone, input.pin);
    setRefreshCookie(res, data.refreshToken);
    auditLogin(req, 'SUCCESS', {
      userId: data.user.id,
      name: data.user.name,
      role: data.user.role,
      phone: input.phone,
    });
    res.json({ success: true, data });
  } catch (err) {
    auditLogin(req, 'FAILED', {
      phone: typeof phone === 'string' ? phone : 'unknown',
      reason: err instanceof Error ? err.message : 'PIN login failed',
    });
    next(err);
  }
});

// Set / replace the quick-login PIN (requires an active session).
authRouter.post('/me/set-pin', requireAuth, async (req, res, next) => {
  try {
    const { pin } = setPinSchema.parse(req.body);
    await authService.setPin(req.auth!.userId, pin);
    const data = await authService.getMe(req.auth!.userId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Step 1 of login/signup: send an OTP to the phone.
authRouter.post('/request-otp', otpRequestLimiter, async (req, res, next) => {
  try {
    const { phone } = requestOtpSchema.parse(req.body);
    const data = await authService.requestOtp(phone);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Step 2: verify the OTP. Creates the account on first login.
// The refresh token is set as an httpOnly cookie (and returned in the body
// for non-browser clients).
authRouter.post('/verify-otp', otpVerifyLimiter, async (req, res, next) => {
  const { phone } = req.body ?? {};
  try {
    const input = verifyOtpSchema.parse(req.body);
    const data = await authService.verifyOtp(input);
    setRefreshCookie(res, data.refreshToken);
    auditLogin(req, 'SUCCESS', {
      userId: data.user.id,
      name: data.user.name,
      role: data.user.role,
      phone: input.phone,
    });
    res.json({ success: true, data });
  } catch (err) {
    // Wrong or expired OTP is exactly what a security review wants to see.
    auditLogin(req, 'FAILED', {
      phone: typeof phone === 'string' ? phone : 'unknown',
      reason: err instanceof Error ? err.message : 'OTP verification failed',
    });
    next(err);
  }
});

// Exchange a refresh token for a new access + refresh pair (rotation).
// Sliding expiry: each rotation issues a fresh full-TTL token, so active
// users effectively never need to re-login on the same device.
authRouter.post('/refresh', async (req, res, next) => {
  try {
    const token = refreshTokenFrom(req);
    if (!token) throw ApiError.unauthorized('No refresh token', 'REFRESH_MISSING');
    const data = await authService.refresh(token);
    setRefreshCookie(res, data.refreshToken);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Revoke this device's refresh token only (other devices stay logged in).
authRouter.post('/logout', async (req, res, next) => {
  try {
    const token = refreshTokenFrom(req);
    if (token) await authService.logout(token);
    clearRefreshCookie(res);
    res.json({ success: true, data: { loggedOut: true } });
  } catch (err) {
    next(err);
  }
});

// Revoke EVERY session for this user ("logout from all devices").
authRouter.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    const { count } = await prisma.refreshToken.updateMany({
      where: { userId: req.auth!.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    clearRefreshCookie(res);
    res.json({ success: true, data: { loggedOut: true, sessionsRevoked: count } });
  } catch (err) {
    next(err);
  }
});

// Update my profile — onboarding + the My Profile edit form.
authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const input = updateProfileSchema.parse(req.body);
    if (input.email) {
      const taken = await prisma.user.findFirst({
        where: { email: input.email, id: { not: req.auth!.userId } },
      });
      if (taken) throw ApiError.badRequest('This email is already in use', 'EMAIL_TAKEN');
    }
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email || null } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
        ...(input.gender !== undefined ? { gender: input.gender } : {}),
        ...(input.dateOfBirth !== undefined
          ? { dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null }
          : {}),
        ...(input.location !== undefined ? { location: input.location || null } : {}),
        ...(input.profession !== undefined ? { profession: input.profession || null } : {}),
        ...(input.interests !== undefined ? { interests: input.interests } : {}),
        ...(input.favouriteBrands !== undefined ? { favouriteBrands: input.favouriteBrands } : {}),
        ...(input.preferredCategories !== undefined
          ? { preferredCategories: input.preferredCategories }
          : {}),
      },
    });
    const data = await authService.getMe(req.auth!.userId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Notification / recommendation preferences (persisted immediately).
authRouter.patch('/me/preferences', requireAuth, async (req, res, next) => {
  try {
    const input = updatePreferencesSchema.parse(req.body);
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: {
        ...(input.email !== undefined ? { notifyEmail: input.email } : {}),
        ...(input.sms !== undefined ? { notifySms: input.sms } : {}),
        ...(input.whatsapp !== undefined ? { notifyWhatsapp: input.whatsapp } : {}),
        ...(input.recommendations !== undefined ? { personalizedRecs: input.recommendations } : {}),
      },
    });
    const data = await authService.getMe(req.auth!.userId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Small profile stats (review count for the account page tiles).
authRouter.get('/me/stats', requireAuth, async (req, res, next) => {
  try {
    const reviews = await prisma.review.count({ where: { userId: req.auth!.userId } });
    res.json({ success: true, data: { reviews } });
  } catch (err) {
    next(err);
  }
});

// --- Phone change: OTP-verified on the NEW number ---

authRouter.post('/me/change-phone/request', requireAuth, async (req, res, next) => {
  try {
    const { newPhone } = phoneChangeRequestSchema.parse(req.body);
    const taken = await prisma.user.findUnique({ where: { phone: newPhone } });
    if (taken) throw ApiError.badRequest('This number is already registered', 'PHONE_TAKEN');
    const data = await authService.requestOtp(newPhone); // cooldown + devOtp in dev
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/me/change-phone/confirm', requireAuth, async (req, res, next) => {
  try {
    const { newPhone, code } = phoneChangeConfirmSchema.parse(req.body);
    const taken = await prisma.user.findUnique({ where: { phone: newPhone } });
    if (taken) throw ApiError.badRequest('This number is already registered', 'PHONE_TAKEN');
    await consumeOtp(newPhone, code);
    await prisma.user.update({ where: { id: req.auth!.userId }, data: { phone: newPhone } });
    await prisma.notification.create({
      data: {
        userId: req.auth!.userId,
        type: 'PHONE_CHANGED',
        title: 'Phone number updated 📱',
        body: `Your login number is now +91 ${newPhone}. Use it for your next login.`,
      },
    });
    const data = await authService.getMe(req.auth!.userId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Current authenticated user.
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const data = await authService.getMe(req.auth!.userId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Security: sessions + a score built from real signals
// ---------------------------------------------------------------------------

/** Live sessions = refresh tokens that are neither revoked nor expired. */
async function liveSessions(userId: string) {
  return prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
}

authRouter.get('/me/sessions', requireAuth, async (req, res, next) => {
  try {
    const rows = await liveSessions(req.auth!.userId);
    const body: SessionInfo[] = rows.map((row, i) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      // The newest live token is this browser in practice — we never see the
      // raw token here, so it is the closest honest signal we have.
      isCurrent: i === 0,
    }));
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

/** Sign one other device out. */
authRouter.delete('/me/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const { count } = await prisma.refreshToken.updateMany({
      where: { id: req.params.id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw ApiError.notFound('Session not found');
    const rows = await liveSessions(userId);
    const body: SessionInfo[] = rows.map((row, i) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      isCurrent: i === 0,
    }));
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me/security', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const [user, sessions] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      liveSessions(userId),
    ]);
    if (!user) throw ApiError.notFound('Account not found');

    const checks = {
      hasPin: !!user.pinHash,
      emailVerified: !!user.emailVerifiedAt,
      // Every account signs in by OTP, so the phone is verified by definition.
      phoneVerified: true,
      loginAlerts: user.notifyEmail || user.notifySms || user.notifyWhatsapp,
      // More than a couple of live devices is worth a nudge, not a penalty.
      fewSessions: sessions.length <= 2,
    };
    const passed = Object.values(checks).filter(Boolean).length;
    const score = Math.round((passed / Object.keys(checks).length) * 100);
    const label =
      score >= 90 ? 'Strong' : score >= 70 ? 'Good' : score >= 45 ? 'Fair' : 'Weak';

    const suggestions: string[] = [];
    if (!checks.hasPin) suggestions.push('Set a 4-digit quick-login PIN');
    if (!checks.emailVerified) suggestions.push('Add and verify an email address');
    if (!checks.loginAlerts) suggestions.push('Turn on at least one login alert channel');
    if (!checks.fewSessions) suggestions.push('Review and sign out devices you no longer use');

    const body: SecurityOverview = {
      hasPin: checks.hasPin,
      emailVerified: checks.emailVerified,
      phoneVerified: checks.phoneVerified,
      loginAlerts: checks.loginAlerts,
      activeSessions: sessions.length,
      score,
      label: label as SecurityOverview['label'],
      suggestions,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

/**
 * Close the account. Everything owned by the user cascades away; orders are
 * kept for the sellers' records but detached from the deleted profile.
 */
authRouter.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const { confirmPhone } = deleteAccountSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.notFound('Account not found');
    if (user.phone !== confirmPhone) {
      throw ApiError.badRequest('Phone number does not match this account', 'CONFIRM_MISMATCH');
    }
    const openOrders = await prisma.order.count({
      where: { userId, status: { in: ['PLACED', 'CONFIRMED', 'PACKED', 'SHIPPED'] } },
    });
    if (openOrders > 0) {
      throw ApiError.badRequest(
        `You have ${openOrders} order(s) still in progress. They must be delivered or cancelled first.`,
        'OPEN_ORDERS',
      );
    }
    await prisma.user.delete({ where: { id: userId } });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});
