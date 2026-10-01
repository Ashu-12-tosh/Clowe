import { describe, expect, it } from 'vitest';
import { sellerRegisterSchema } from './seller';

const base = { shopName: 'Marigold Threads' };

describe('sellerRegisterSchema bank details', () => {
  it('accepts a registration with no bank details at all', () => {
    expect(sellerRegisterSchema.safeParse(base).success).toBe(true);
  });

  it('requires the bank name once any bank detail is given', () => {
    const r = sellerRegisterSchema.safeParse({ ...base, bankAccountNo: '1234567890', bankIfsc: 'HDFC0001234' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['bankName']);
  });

  it('is satisfied by a bank name', () => {
    const r = sellerRegisterSchema.safeParse({
      ...base,
      bankName: 'HDFC Bank',
      bankAccountNo: '1234567890',
      bankIfsc: 'HDFC0001234',
    });
    expect(r.success).toBe(true);
  });
});
