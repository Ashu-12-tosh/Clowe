import { z } from 'zod';
import type { UserRole } from './index';

/**
 * Indian 10-digit mobile number (stored without +91).
 * Kept permissive enough for dev; providers validate again on their side.
 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'OTP must be 6 digits');

/** POST /api/auth/request-otp */
export const requestOtpSchema = z.object({
  phone: phoneSchema,
});
export type RequestOtpInput = z.infer<typeof requestOtpSchema>;

/** POST /api/auth/verify-otp */
export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
  /** Optional display name, used only when this verify creates a new account. */
  name: z.string().trim().min(2).max(60).optional(),
  /** Optional referral code entered at signup. */
  referralCode: z.string().trim().min(4).max(20).optional(),
});
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

/** PATCH /api/auth/me — profile completion / edits. */
export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  email: z.string().trim().email().optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** POST /api/auth/refresh and /api/auth/logout */
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20),
});
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

/** Public shape of a user returned by the API (never includes secrets). */
export interface AuthUser {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  role: UserRole;
  referralCode: string;
  createdAt: string;
}

/** Response of verify-otp and refresh. */
export interface AuthTokensResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  /** True when verify-otp just created the account. */
  isNewUser?: boolean;
}
