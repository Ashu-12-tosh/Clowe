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

/** Returns the payload, or null when the token is invalid/expired. */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'clowe-api' });
    if (typeof decoded === 'string' || !decoded.sub) return null;
    return { sub: decoded.sub, role: decoded.role as UserRole };
  } catch {
    return null;
  }
}
