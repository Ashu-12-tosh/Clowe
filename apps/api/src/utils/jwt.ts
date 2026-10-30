import jwt from 'jsonwebtoken';
import type { UserRole } from '@clowe/shared';
import { env } from '../env';

export interface AccessTokenPayload {
  sub: string; // user id
  role: UserRole;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: `${env.JWT_ACCESS_TTL_MIN}m`,
    issuer: 'clowe-api',
  });
}

/**
 * Sign-up: proof that this browser verified the number by OTP, carried from
 * the "Verify" button to "Create account". Its own audience and no subject,
 * so it is never accepted as an access token (or one as it), and short-lived.
 */
const PHONE_TOKEN_AUDIENCE = 'clowe-signup-phone';
export const PHONE_TOKEN_TTL_MIN = 20;

export function signPhoneToken(phone: string): string {
  return jwt.sign({ phone }, env.JWT_ACCESS_SECRET, { expiresIn: `${PHONE_TOKEN_TTL_MIN}m`, issuer: 'clowe-api', audience: PHONE_TOKEN_AUDIENCE });
}

/** Is this a live proof that `phone` was verified? */
export function verifyPhoneToken(token: string, phone: string): boolean {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'clowe-api', audience: PHONE_TOKEN_AUDIENCE });
    return typeof decoded !== 'string' && decoded.phone === phone;
  } catch {
    return false;
  }
}

/**
 * "Forgot PIN?": proof that this browser entered the right code for the
 * account, carried from the code step to the new-PIN step. It names the user
 * in its own claim (never `sub`) under its own audience, so it can never pass
 * as an access token; and it is bound to the PIN as it was, so once a new PIN
 * is saved the same token is worthless.
 */
const PIN_RESET_AUDIENCE = 'clowe-pin-reset';
export const PIN_RESET_TOKEN_TTL_MIN = 15;

export function signPinResetToken(userId: string, pinVersion: string): string {
  return jwt.sign({ uid: userId, pv: pinVersion }, env.JWT_ACCESS_SECRET, {
    expiresIn: `${PIN_RESET_TOKEN_TTL_MIN}m`,
    issuer: 'clowe-api',
    audience: PIN_RESET_AUDIENCE,
  });
}

/** The user and PIN version a live reset token was issued for, else null. */
export function verifyPinResetToken(token: string): { userId: string; pinVersion: string } | null {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'clowe-api', audience: PIN_RESET_AUDIENCE });
    if (typeof decoded === 'string' || typeof decoded.uid !== 'string' || typeof decoded.pv !== 'string') return null;
    return { userId: decoded.uid, pinVersion: decoded.pv };
  } catch {
    return null;
  }
}

/** Returns the payload, or null when the token is invalid/expired. */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'clowe-api' });
    // Access tokens carry no audience: one that does is some other proof
    // (sign-up phone, PIN reset) and never signs anyone in.
    if (typeof decoded === 'string' || !decoded.sub || decoded.aud !== undefined) return null;
    return { sub: decoded.sub, role: decoded.role as UserRole };
  } catch {
    return null;
  }
}

/**
 * Track Order: proof that this browser entered the code sent to the phone or
 * email on one order. It names only that order, under its own audience, so it
 * opens nothing else and is never an access token.
 */
const TRACK_AUDIENCE = 'clowe-track-order';
export const TRACK_TOKEN_TTL_MIN = 30;

export function signTrackToken(orderId: string): string {
  return jwt.sign({ oid: orderId }, env.JWT_ACCESS_SECRET, { expiresIn: `${TRACK_TOKEN_TTL_MIN}m`, issuer: 'clowe-api', audience: TRACK_AUDIENCE });
}

/** The order a live track token opens, else null. */
export function verifyTrackToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'clowe-api', audience: TRACK_AUDIENCE });
    return typeof decoded !== 'string' && typeof decoded.oid === 'string' ? decoded.oid : null;
  } catch {
    return null;
  }
}
