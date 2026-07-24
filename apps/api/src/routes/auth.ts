import { Router } from 'express';
import {
  requestOtpSchema,
  verifyOtpSchema,
  refreshTokenSchema,
  updateProfileSchema,
} from '@clowe/shared';
import { prisma } from '../db';
import { authService } from '../services/authService';
import { requireAuth } from '../middleware/auth';
import { otpRequestLimiter, otpVerifyLimiter } from '../middleware/rateLimits';

export const authRouter = Router();

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
authRouter.post('/verify-otp', otpVerifyLimiter, async (req, res, next) => {
  try {
    const input = verifyOtpSchema.parse(req.body);
    const data = await authService.verifyOtp(input);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Exchange a refresh token for a new access + refresh pair (rotation).
authRouter.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = refreshTokenSchema.parse(req.body);
    const data = await authService.refresh(refreshToken);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Revoke the given refresh token (logout on this device).
authRouter.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = refreshTokenSchema.parse(req.body);
    await authService.logout(refreshToken);
    res.json({ success: true, data: { loggedOut: true } });
  } catch (err) {
    next(err);
  }
});

// Update my profile (name/email) — used by the signup onboarding step.
authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const input = updateProfileSchema.parse(req.body);
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: { ...(input.name ? { name: input.name } : {}), ...(input.email ? { email: input.email } : {}) },
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
