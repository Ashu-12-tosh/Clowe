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
