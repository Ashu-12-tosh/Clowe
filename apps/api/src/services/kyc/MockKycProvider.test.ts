import { describe, expect, it } from 'vitest';
import { KycProviderError } from './KycProvider';
import { MockKycProvider } from './MockKycProvider';

/** The mock's magic inputs are its documentation; these keep the two honest. */

const mock = new MockKycProvider();

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof KycProviderError) return err.reason;
    throw err;
  }
  throw new Error('expected a KycProviderError');
}

describe('mock KYC provider', () => {
  it('verifies ordinary details with a direct name match', async () => {
    expect(await mock.verifyPAN('ABCDE1234F', 'Rahul Sharma')).toEqual({
      status: 'VERIFIED',
      reason: null,
      nameMatch: { score: 100, band: 'DIRECT_MATCH' },
    });
    expect((await mock.verifyGSTIN('29ABCDE1234F1Z5')).status).toBe('VERIFIED');
    expect((await mock.verifyBank('1234567890', 'HDFC0001234', 'Rahul Sharma')).status).toBe('VERIFIED');
  });

  it('produces every band from a magic name', async () => {
    const cases: [string, number, string][] = [
      ['Rahul MOCK GOOD', 90, 'GOOD_PARTIAL_MATCH'],
      ['Rahul MOCK MODERATE', 70, 'MODERATE_PARTIAL_MATCH'],
      ['Rahul MOCK POOR', 45, 'POOR_PARTIAL_MATCH'],
      ['Rahul MOCK NOMATCH', 10, 'NO_MATCH'],
    ];
    for (const [name, score, band] of cases) {
      expect((await mock.verifyPAN('ABCDE1234F', name)).nameMatch).toEqual({ score, band });
    }
  });

  it('produces every failure from a magic ID', async () => {
    expect((await mock.verifyPAN('ZZZZZ1234F', 'x')).reason).toBe('PAN_INVALID');
    expect((await mock.verifyPAN('YYYYY1234F', 'x')).reason).toBe('PAN_INACTIVE');
    expect((await mock.verifyGSTIN('00ABCDE1234F1Z5')).reason).toBe('GSTIN_NOT_FOUND');
    expect((await mock.verifyGSTIN('90ABCDE1234F1Z5')).reason).toBe('GSTIN_INACTIVE');
    expect((await mock.verifyBank('1234560000', 'HDFC0001234', null)).reason).toBe('ACCOUNT_INVALID');
    expect((await mock.verifyBank('1234561111', 'HDFC0001234', null)).reason).toBe('ACCOUNT_BLOCKED');
    expect((await mock.verifyBank('1234566666', 'HDFC0001234', null)).reason).toBe('FRAUD_ACCOUNT');
    expect((await mock.verifyBank('1234567890', 'XXXX0001234', null)).reason).toBe('IFSC_INVALID');
  });

  it('produces a provider error from a magic ID, so the retry path can be exercised', async () => {
    expect(await reasonOf(mock.verifyPAN('EEEEE1234F', 'x'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await reasonOf(mock.verifyGSTIN('91ABCDE1234F1Z5'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await reasonOf(mock.verifyBank('1234569999', 'HDFC0001234', null))).toBe('BANK_UNAVAILABLE');
  });

  it('reports no name match when no name was asked for', async () => {
    expect((await mock.verifyBank('1234567890', 'HDFC0001234', null)).nameMatch).toBeNull();
  });
});
