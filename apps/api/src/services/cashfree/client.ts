import { constants, publicEncrypt } from 'node:crypto';

/**
 * What every Cashfree product shares: which host to call, and how to sign a
 * request for two-factor authentication.
 *
 * Verification is the first product on this account; payments and payouts are
 * meant to follow. They sit under different paths (/verification, /pg,
 * /payout) with separate API keys, but the same host per environment and the
 * same signature scheme — so this file is the part they can all use, and each
 * product keeps its own client beside it. Each product also has its own
 * environment setting: verification can be live while payouts are in sandbox.
 */

export type CashfreeEnvironment = 'sandbox' | 'production';

/** Sandbox never bills; production does. */
export function cashfreeHost(environment: CashfreeEnvironment): string {
  return environment === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
}

/**
 * The x-cf-signature header, for accounts using public-key 2FA instead of an
 * IP allowlist: `clientId.unixSeconds`, RSA-OAEP (SHA-1) encrypted with the
 * public key Cashfree issued, base64. Valid for a few minutes, so it is made
 * per request rather than cached.
 */
export function cashfreeSignature(clientId: string, publicKeyPem: string, now = Date.now()): string {
  const plaintext = `${clientId}.${Math.floor(now / 1000)}`;
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(plaintext),
  ).toString('base64');
}

/**
 * A PEM key as it survives an env file: on one line, with literal "\n" where
 * the line breaks were. Real newlines are left alone.
 */
export function pemFromEnv(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}
