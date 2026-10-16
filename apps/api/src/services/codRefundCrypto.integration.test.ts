import { describe, expect, it } from 'vitest';
import { decryptCodRefundAccount, encryptCodRefundAccount } from './codRefundCrypto';

const account = { accountName: 'Riya Sharma', accountNumber: '123456789012', ifsc: 'HDFC0001234' };

describe('COD refund account encryption', () => {
  it('round-trips, and the stored text reveals nothing', () => {
    const stored = encryptCodRefundAccount(account);
    expect(stored).toMatch(/^v1:/);
    for (const secret of ['123456789012', 'HDFC0001234', 'Riya']) expect(stored).not.toContain(secret);
    expect(decryptCodRefundAccount(stored)).toEqual(account);
  });

  it('uses a fresh IV each time', () => {
    expect(encryptCodRefundAccount(account)).not.toBe(encryptCodRefundAccount(account));
  });

  it('refuses a record that was tampered with', () => {
    const [v, iv, tag, data] = encryptCodRefundAccount(account).split(':');
    const flipped = Buffer.from(data!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptCodRefundAccount([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });
});
