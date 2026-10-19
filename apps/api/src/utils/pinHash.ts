import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { env } from '../env';
import { hashMatches } from './crypto';

// ---------------------------------------------------------------------------
// Quick-login PIN hashes.
//
// Now: scrypt with a random salt per PIN, stored as "scrypt1$<salt>$<hash>".
// Slow on purpose — a 4-digit PIN has only 10,000 values, so each guess from
// a stolen table has to cost something — and it depends on no other secret.
//
// Before (pre-launch audit 2026-10-20, D2): sha256(userId:pin:JWT_ACCESS_SECRET).
// Rotating the JWT secret would have turned every saved PIN into "wrong".
// Those hashes still verify, and are replaced by scrypt at the next sign-in.
// ---------------------------------------------------------------------------

const PREFIX = 'scrypt1';
const KEY_LENGTH = 32;
const COST = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pin, salt, KEY_LENGTH, COST, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  return `${PREFIX}$${salt.toString('base64')}$${(await derive(pin, salt)).toString('base64')}`;
}

/** Does `pin` match the stored hash? `legacy` says it should be re-hashed. */
export async function verifyPin(userId: string, pin: string, stored: string): Promise<{ ok: boolean; legacy: boolean }> {
  if (stored.startsWith(`${PREFIX}$`)) {
    const [, saltB64, hashB64] = stored.split('$');
    const expected = Buffer.from(hashB64 ?? '', 'base64');
    const actual = await derive(pin, Buffer.from(saltB64 ?? '', 'base64'));
    return { ok: expected.length === actual.length && timingSafeEqual(expected, actual), legacy: false };
  }
  return { ok: hashMatches(`${userId}:${pin}:${env.JWT_ACCESS_SECRET}`, stored), legacy: true };
}
