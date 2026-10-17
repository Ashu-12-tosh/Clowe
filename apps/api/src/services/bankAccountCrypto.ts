import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../env';

/**
 * A seller's bank account number at rest: AES-256-GCM with a fresh 12-byte IV
 * per record, the key derived (HKDF-SHA256, its own label) from COD_REFUND_KEY
 * — or JWT_ACCESS_SECRET when that is unset — like the COD refund accounts.
 * Stored as "v1:<iv>:<tag>:<ciphertext>" (base64). Only the last 4 digits are
 * shown anywhere; the full number is read for the bank check and for the
 * admin who verifies it against the cheque.
 */
const VERSION = 'v1';
const derive = (secret: string) => Buffer.from(hkdfSync('sha256', secret, 'clowe', 'seller-bank-account-v1', 32));
const writeKey = () => derive(env.COD_REFUND_KEY ?? env.JWT_ACCESS_SECRET);
const readKeys = () => (env.COD_REFUND_KEY ? [derive(env.COD_REFUND_KEY), derive(env.JWT_ACCESS_SECRET)] : [writeKey()]);

export function encryptBankAccount(accountNumber: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', writeKey(), iv);
  const data = Buffer.concat([cipher.update(accountNumber, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptBankAccount(stored: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('Unreadable bank account record');
  let lastError: unknown;
  for (const k of readKeys()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** The account number on file: the encrypted column, or the old plain one for accounts saved before it. */
export function bankAccountNumberOf(s: { bankAccountEnc: string | null; bankAccountNo: string | null }): string | null {
  if (s.bankAccountEnc) return decryptBankAccount(s.bankAccountEnc);
  return s.bankAccountNo?.trim() || null;
}
