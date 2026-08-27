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

export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const;
export type Gender = (typeof GENDERS)[number];
export const GENDER_LABELS: Record<Gender, string> = {
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
  PREFER_NOT_TO_SAY: 'Prefer not to say',
};

/** PATCH /api/auth/me — profile completion / edits. */
/** Options offered in the "About you" pickers. */
export const INTEREST_OPTIONS = [
  'Tech', 'Fashion', 'Fitness', 'Books', 'Beauty', 'Home', 'Gaming', 'Travel', 'Music', 'Food',
] as const;

export const PROFESSION_OPTIONS = [
  'Student', 'Working professional', 'Business owner', 'Homemaker', 'Freelancer', 'Retired', 'Other',
] as const;

const shortList = (max: number) =>
  z.array(z.string().trim().min(1).max(40)).max(max).optional();

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  email: z.string().trim().email().optional(),
  location: z.string().trim().max(80).nullable().optional(),
  profession: z.string().trim().max(60).nullable().optional(),
  interests: shortList(12),
  favouriteBrands: shortList(12),
  preferredCategories: shortList(12),
  avatarUrl: z.string().url().nullable().optional(),
  gender: z.enum(GENDERS).nullable().optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .nullable()
    .optional()
    .refine(
      (value) => {
        if (!value) return true;
        const dob = new Date(value);
        if (Number.isNaN(dob.getTime()) || dob >= new Date()) return false;
        const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
        return age >= 13 && age <= 120;
      },
      { message: 'Enter a valid past date (you must be at least 13)' },
    ),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** PATCH /api/auth/me/preferences */
export const updatePreferencesSchema = z.object({
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
  recommendations: z.boolean().optional(),
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

/** 4-digit quick-login PIN. */
export const pinSchema = z.string().regex(/^\d{4}$/, 'PIN must be 4 digits');

/** POST /api/auth/check-phone — does this account exist / have a PIN? */
export const checkPhoneSchema = z.object({ phone: phoneSchema });

/** POST /api/auth/pin-login */
export const pinLoginSchema = z.object({ phone: phoneSchema, pin: pinSchema });

/** POST /api/auth/me/set-pin */
export const setPinSchema = z.object({ pin: pinSchema });

/** Phone change — OTP-verified on the NEW number. */
export const phoneChangeRequestSchema = z.object({ newPhone: phoneSchema });
export const phoneChangeConfirmSchema = z.object({ newPhone: phoneSchema, code: otpCodeSchema });

/**
 * POST /api/auth/refresh and /api/auth/logout.
 * The refresh token normally travels in an httpOnly cookie; the body field is
 * a fallback (older sessions / future mobile app).
 */
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20).optional(),
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
  dateOfBirth: string | null; // YYYY-MM-DD
  gender: Gender | null;
  avatarUrl: string | null;
  /** True when a quick-login PIN is set (never the PIN itself). */
  hasPin: boolean;
  /** Optional "About you" profile — powers recommendations. */
  location: string | null;
  profession: string | null;
  interests: string[];
  favouriteBrands: string[];
  preferredCategories: string[];
  emailVerified: boolean;
  /** Premium membership — free standard delivery with no minimum. */
  isPremium: boolean;
  prefs: { email: boolean; sms: boolean; whatsapp: boolean; recommendations: boolean };
}

/** Response of verify-otp and refresh. */
export interface AuthTokensResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  /** True when verify-otp just created the account. */
  isNewUser?: boolean;
}

// ---------------------------------------------------------------------------
// Account security
// ---------------------------------------------------------------------------

/** One signed-in device, from the refresh-token trail. */
export interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** The session making this request. */
  isCurrent: boolean;
}

export interface SecurityOverview {
  hasPin: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
  loginAlerts: boolean;
  activeSessions: number;
  /** 0-100, derived from the checks above. */
  score: number;
  label: 'Weak' | 'Fair' | 'Good' | 'Strong';
  /** What would raise the score, in priority order. */
  suggestions: string[];
}

/** DELETE /api/auth/me — typing the phone number confirms intent. */
export const deleteAccountSchema = z.object({
  confirmPhone: phoneSchema,
});
