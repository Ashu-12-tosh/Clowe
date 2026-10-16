import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { CodRefundAccountInput, CodRefundAccountView } from '@clowe/shared';
import { env } from '../env';

/**
 * Encryption for the bank details Cash on Delivery buyers give for a refund:
 * AES-256-GCM, a fresh 12-byte IV per record, the key derived (HKDF-SHA256)
 * from COD_REFUND_KEY — or JWT_ACCESS_SECRET when that is unset. Stored as
 * "v1:<iv>:<tag>:<ciphertext>", base64. Tampering fails decryption.
 */
const VERSION = 'v1';

const derive = (secret: string) => Buffer.from(hkdfSync('sha256', secret, 'clowe', 'cod-refund-account-v1', 32));

/** The key new records are written with. */
function key(): Buffer {
  return derive(env.COD_REFUND_KEY ?? env.JWT_ACCESS_SECRET);
}

/**
 * Keys a stored record may have been written with: the current one, then —
 * once COD_REFUND_KEY is set — the JWT-derived key used before it, so
 * records written earlier stay readable.
 */
function readKeys(): Buffer[] {
  return env.COD_REFUND_KEY ? [derive(env.COD_REFUND_KEY), derive(env.JWT_ACCESS_SECRET)] : [key()];
}

export function encryptCodRefundAccount(account: Pick<CodRefundAccountInput, 'accountName' | 'accountNumber' | 'ifsc'>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const plain = JSON.stringify({ accountName: account.accountName, accountNumber: account.accountNumber, ifsc: account.ifsc });
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptCodRefundAccount(stored: string): CodRefundAccountView {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('Unreadable refund account record');
  let lastError: unknown;
  for (const k of readKeys()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
      return JSON.parse(plain) as CodRefundAccountView;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
