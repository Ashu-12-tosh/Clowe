import { z } from 'zod';
import type { UserRole } from './index';
import { imageUrlSchema } from './imageUrl';

/**
 * An Indian mobile number as people type or paste it — "+91 98765 43210",
 * "919876543210", "098765-43210", "(98765) 43210" — reduced to the 10 digits
 * it is stored as. The same function runs at sign-up and at every login, so a
 * number can never be stored one way and looked up another. Anything that is
 * not a number of that shape comes back as its digits, for the schema to refuse.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/** An email address as stored and looked up: trimmed, lower-case. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Indian 10-digit mobile number (stored without +91). Accepts the number in
 * any of the usual written forms (see normalizePhone).
 */
export const phoneSchema = z.preprocess(
  (v) => (typeof v === 'string' ? normalizePhone(v) : v),
  z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
);

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
  /**
   * PIN_RESET ("Forgot PIN?"): on success the old PIN stops working at once,
   * the lockout clears, every other session is signed out, and the answer
   * says a new PIN must be set (pinResetRequired).
   */
  purpose: z.enum(['LOGIN', 'PIN_RESET']).default('LOGIN'),
  /** The Terms/Privacy version shown beside the button ("By continuing you…"). */
  termsVersion: z.string().trim().max(20).optional(),
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

/** An email address as customers type it: trimmed, a real-looking address. */
export const customerEmailSchema = z
  .string()
  .trim()
  .max(120, 'That email address is too long')
  .email('Enter a valid email address, like name@example.com');

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  /** '' removes the address. A new one is confirmed by a one-time link. */
  email: customerEmailSchema.or(z.literal('')).optional(),
  location: z.string().trim().max(80).nullable().optional(),
  profession: z.string().trim().max(60).nullable().optional(),
  interests: shortList(12),
  favouriteBrands: shortList(12),
  preferredCategories: shortList(12),
  avatarUrl: imageUrlSchema.nullable().optional(),
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

/** POST /api/auth/verify-email — the token from the one-time link. */
export const verifyEmailSchema = z.object({ token: z.string().trim().min(20).max(200) });

/** PATCH /api/auth/me/preferences */
export const updatePreferencesSchema = z.object({
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
  recommendations: z.boolean().optional(),
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

/**
 * 4-digit PIN, always a string: "0123" keeps its leading zero (a number would
 * not), and a space a password manager or paste added is dropped.
 */
export const pinSchema = z
  .string({ invalid_type_error: 'PIN must be 4 digits' })
  .transform((v) => v.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{4}$/, 'PIN must be 4 digits'));

/** POST /api/auth/check-phone: kept for older pages, same answer for every number. */
export const checkPhoneSchema = z.object({ phone: phoneSchema });

/** What someone typed to sign in: a phone number or an email address. */
export type LoginIdentifier = { kind: 'phone'; value: string } | { kind: 'email'; value: string };

/** Mobile number or email, normalised the way sign-up stores them; null when it is neither. */
export function parseLoginIdentifier(raw: string): LoginIdentifier | null {
  const text = raw.trim();
  if (text.includes('@')) {
    const email = customerEmailSchema.safeParse(normalizeEmail(text));
    return email.success ? { kind: 'email', value: email.data } : null;
  }
  const phone = phoneSchema.safeParse(text);
  return phone.success ? { kind: 'phone', value: phone.data } : null;
}

export const loginIdentifierSchema = z
  .string()
  .max(160)
  .transform((v, ctx) => {
    const id = parseLoginIdentifier(v);
    if (!id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter your 10-digit mobile number or your email address' });
      return z.NEVER;
    }
    return id;
  });

/** POST /api/auth/lookup — is there an account for this number or email? */
export const accountLookupSchema = z.object({ identifier: loginIdentifierSchema });

export interface AccountLookupResult {
  exists: boolean;
  /** The identifier as normalised (what the next step sends back). */
  kind: 'phone' | 'email';
  identifier: string;
  /** The account has a PIN; otherwise the next step sets one by OTP. */
  hasPin: boolean;
  /** "+91 98XXX XX210": where a reset code goes. Null when there is no account. */
  phoneMasked: string | null;
}

/**
 * POST /api/auth/pin-login. `identifier` (phone or email) is what the login
 * page sends; `phone` is kept for the seller login and older clients.
 */
export const pinLoginSchema = z
  .object({
    identifier: loginIdentifierSchema.optional(),
    phone: phoneSchema.optional(),
    pin: pinSchema,
    /** The Terms/Privacy version shown beside the button ("By continuing you…"). */
    termsVersion: z.string().trim().max(20).optional(),
  })
  .refine((v) => v.identifier || v.phone, { message: 'Enter your mobile number or email', path: ['identifier'] })
  .transform(({ identifier, phone, ...rest }) => ({ ...rest, identifier: identifier ?? { kind: 'phone' as const, value: phone! } }));

const newPinFields = {
  pin: pinSchema,
  confirmPin: pinSchema,
};
const pinsMatch = (v: { pin: string; confirmPin: string }) => v.pin === v.confirmPin;
const PINS_DIFFER = { message: 'The two PINs don’t match', path: ['confirmPin'] };

/** POST /api/auth/signup/verify-phone — the OTP sent to the new number. */
export const signupVerifyPhoneSchema = z.object({ phone: phoneSchema, code: otpCodeSchema });
export interface SignupPhoneVerified {
  /** Short-lived proof the number was verified, sent with the account details. */
  phoneToken: string;
}

/** POST /api/auth/signup — the Create account form. */
export const signupSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your name').max(60),
    phone: phoneSchema,
    phoneToken: z.string().min(20).max(1000),
    email: customerEmailSchema.transform(normalizeEmail).or(z.literal('')).optional(),
    ...newPinFields,
    referralCode: z.string().trim().min(4).max(20).optional(),
    termsVersion: z.string().trim().max(20).optional(),
  })
  .refine(pinsMatch, PINS_DIFFER);

/** POST /api/auth/pin-reset/request — "Forgot PIN?": a code to the account's phone. */
export const pinResetRequestSchema = z.object({ identifier: loginIdentifierSchema });
export interface PinResetRequestResult extends OtpRequestResult {
  phoneMasked: string;
}

/** POST /api/auth/pin-reset/confirm — the code and the new PIN, in one step. */
export const pinResetConfirmSchema = z
  .object({
    identifier: loginIdentifierSchema,
    code: otpCodeSchema,
    ...newPinFields,
    termsVersion: z.string().trim().max(20).optional(),
  })
  .refine(pinsMatch, PINS_DIFFER);

/** "+91 98XXX XX210" */
export function maskPhone(phone: string): string {
  return `+91 ${phone.slice(0, 2)}XXX XX${phone.slice(7)}`;
}

/** POST /api/auth/me/set-pin. confirmPin, when sent, must match. */
export const setPinSchema = z
  .object({ pin: pinSchema, confirmPin: pinSchema.optional() })
  .refine((v) => v.confirmPin === undefined || v.confirmPin === v.pin, {
    message: 'The two PINs don’t match',
    path: ['confirmPin'],
  });

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
  /** Premium membership. (Delivery is free for everyone now.) */
  isPremium: boolean;
  prefs: { email: boolean; sms: boolean; whatsapp: boolean; recommendations: boolean };
}

/** Response of verify-otp and refresh. */
/** POST /api/auth/request-otp. */
export interface OtpRequestResult {
  /** Seconds until another code may be requested for this number. */
  resendAfterSec: number;
  /** Seconds a code stays valid. Every code sent in that time works. */
  expiresInSec: number;
  /** Only with the mock provider outside production. */
  devOtp?: string;
}

export interface AuthTokensResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  /** True when verify-otp just created the account. */
  isNewUser?: boolean;
  /** A "Forgot PIN?" verification: the old PIN is gone and a new one must be set. */
  pinResetRequired?: boolean;
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
