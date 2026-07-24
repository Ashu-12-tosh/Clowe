import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digest — used for OTP codes and refresh tokens before storage. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of a plain value against a stored sha256 hash. */
export function hashMatches(plain: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(plain), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Cryptographically random 6-digit OTP. */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Opaque refresh token (sent to the client; only its hash is stored). */
export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

/**
 * Short human-shareable referral code, e.g. "CLW-8FK2QZ".
 * Unambiguous alphabet (no 0/O/1/I/L).
 */
export function generateReferralCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[randomInt(alphabet.length)];
  }
  return `CLW-${code}`;
}
