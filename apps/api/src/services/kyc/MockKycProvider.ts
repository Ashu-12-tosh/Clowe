import { normalizeTaxId } from '@clowe/shared';
import { KycProviderError, type KycProvider, type KycResult, type NameMatch } from './KycProvider';

/**
 * Free dev provider: no network, no cost, deterministic answers.
 *
 * Every well-formed input verifies with a direct name match. A handful of
 * magic inputs produce everything else, so every screen and every branch of
 * the caller can be exercised without a real account:
 *
 *   PAN starting ZZZZZ           FAILED  PAN_INVALID
 *   PAN starting YYYYY           FAILED  PAN_INACTIVE
 *   PAN starting EEEEE           ERROR   PROVIDER_UNAVAILABLE
 *
 *   GSTIN state code 00          FAILED  GSTIN_NOT_FOUND
 *   GSTIN state code 90          FAILED  GSTIN_INACTIVE
 *   GSTIN state code 91          ERROR   PROVIDER_UNAVAILABLE
 *
 *   account ending 0000          FAILED  ACCOUNT_INVALID
 *   account ending 1111          FAILED  ACCOUNT_BLOCKED
 *   account ending 6666          FAILED  FRAUD_ACCOUNT
 *   account ending 9999          ERROR   BANK_UNAVAILABLE
 *   IFSC starting XXXX           FAILED  IFSC_INVALID
 *
 *   name containing MOCK GOOD      90  GOOD_PARTIAL_MATCH
 *   name containing MOCK MODERATE  70  MODERATE_PARTIAL_MATCH
 *   name containing MOCK POOR      45  POOR_PARTIAL_MATCH
 *   name containing MOCK NOMATCH   10  NO_MATCH
 *   any other name                100  DIRECT_MATCH
 *
 * The name rules are a lookup table, not matching logic: scores come from the
 * provider, and the mock only stands in for one.
 */
export class MockKycProvider implements KycProvider {
  readonly name = 'mock';

  async verifyPAN(pan: string, name: string): Promise<KycResult> {
    const p = normalizeTaxId(pan);
    if (p.startsWith('EEEEE')) throw new KycProviderError('PROVIDER_UNAVAILABLE', 'mock: magic PAN');
    if (p.startsWith('ZZZZZ')) return { status: 'FAILED', reason: 'PAN_INVALID', nameMatch: null };
    if (p.startsWith('YYYYY')) return { status: 'FAILED', reason: 'PAN_INACTIVE', nameMatch: null };
    return { status: 'VERIFIED', reason: null, nameMatch: mockNameMatch(name) };
  }

  async verifyGSTIN(gstin: string): Promise<KycResult> {
    const state = normalizeTaxId(gstin).slice(0, 2);
    if (state === '91') throw new KycProviderError('PROVIDER_UNAVAILABLE', 'mock: magic GSTIN');
    if (state === '00') return { status: 'FAILED', reason: 'GSTIN_NOT_FOUND', nameMatch: null };
    if (state === '90') return { status: 'FAILED', reason: 'GSTIN_INACTIVE', nameMatch: null };
    return { status: 'VERIFIED', reason: null, nameMatch: null };
  }

  async verifyBank(accountNumber: string, ifsc: string, name: string | null): Promise<KycResult> {
    const account = normalizeTaxId(accountNumber);
    if (account.endsWith('9999')) throw new KycProviderError('BANK_UNAVAILABLE', 'mock: magic account');
    if (normalizeTaxId(ifsc).startsWith('XXXX')) {
      return { status: 'FAILED', reason: 'IFSC_INVALID', nameMatch: null };
    }
    if (account.endsWith('0000')) return { status: 'FAILED', reason: 'ACCOUNT_INVALID', nameMatch: null };
    if (account.endsWith('1111')) return { status: 'FAILED', reason: 'ACCOUNT_BLOCKED', nameMatch: null };
    if (account.endsWith('6666')) return { status: 'FAILED', reason: 'FRAUD_ACCOUNT', nameMatch: null };
    return { status: 'VERIFIED', reason: null, nameMatch: name === null ? null : mockNameMatch(name) };
  }
}

function mockNameMatch(name: string): NameMatch {
  const n = name.toUpperCase();
  if (n.includes('MOCK GOOD')) return { score: 90, band: 'GOOD_PARTIAL_MATCH' };
  if (n.includes('MOCK MODERATE')) return { score: 70, band: 'MODERATE_PARTIAL_MATCH' };
  if (n.includes('MOCK POOR')) return { score: 45, band: 'POOR_PARTIAL_MATCH' };
  if (n.includes('MOCK NOMATCH')) return { score: 10, band: 'NO_MATCH' };
  return { score: 100, band: 'DIRECT_MATCH' };
}
