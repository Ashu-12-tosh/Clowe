import { describe, expect, it } from 'vitest';
import { codRefundAccountSchema, codRefundPaidSchema, maskLast4 } from './codRefund';

const good = { accountName: 'Riya Sharma', accountNumber: '1234 5678 9012', ifsc: 'hdfc0001234', ownAccount: true as const };
const errorsOf = (r: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('COD refund bank account (Refund Policy 6.4)', () => {
  it('takes an account number and IFSC, normalised', () => {
    const r = codRefundAccountSchema.safeParse(good);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ accountNumber: '123456789012', ifsc: 'HDFC0001234' });
  });

  it('refuses a malformed account number or IFSC, under its own field', () => {
    const r = codRefundAccountSchema.safeParse({ ...good, accountNumber: '12AB', ifsc: 'HDFC1234' });
    expect(errorsOf(r)).toEqual({
      accountNumber: expect.stringMatching(/9 to 18 digits/),
      ifsc: expect.stringMatching(/HDFC0001234/),
    });
  });

  it('must be in the buyer’s own name, confirmed', () => {
    expect(errorsOf(codRefundAccountSchema.safeParse({ ...good, ownAccount: false }))).toEqual({
      ownAccount: expect.stringMatching(/own name/),
    });
    expect(errorsOf(codRefundAccountSchema.safeParse({ ...good, accountName: 'x1' }))).toHaveProperty('accountName');
  });

  it('has no UPI option', () => {
    expect(codRefundAccountSchema.safeParse({ upiId: 'riya@okhdfc', ownAccount: true }).success).toBe(false);
  });
});

describe('masking', () => {
  it('shows only the last four characters', () => {
    expect(maskLast4('123456789012')).toBe('••••••••9012');
    expect(maskLast4('9012')).toBe('••••9012');
  });
});

describe('marking a COD refund paid', () => {
  it('needs the bank reference', () => {
    expect(codRefundPaidSchema.safeParse({ reference: 'UTR1234567890' }).success).toBe(true);
    expect(codRefundPaidSchema.safeParse({ reference: '12' }).success).toBe(false);
  });
});
