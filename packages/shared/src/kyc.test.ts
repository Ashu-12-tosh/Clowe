import { describe, expect, it } from 'vitest';
import {
  kycApprovalWarnings,
  panFromGstin,
  panGstinMismatch,
  toSellerKycStatus,
  type KycCheckView,
  type SellerKycSummary,
} from './kyc';

describe('the PAN inside a GSTIN', () => {
  it('is characters 3 to 12', () => {
    expect(panFromGstin('29ABCDE1234F1Z5')).toBe('ABCDE1234F');
  });

  it('is read the same however the GSTIN was typed', () => {
    expect(panFromGstin(' 29abcde1234f1z5 ')).toBe('ABCDE1234F');
  });

  it('does not exist in a malformed GSTIN', () => {
    expect(panFromGstin('29ABCDE1234')).toBeNull();
  });
});

describe('PAN–GSTIN mismatch', () => {
  it('is false when the GSTIN carries the PAN on file', () => {
    expect(panGstinMismatch('ABCDE1234F', '29ABCDE1234F1Z5')).toBe(false);
  });

  it('is true when it carries a different one', () => {
    expect(panGstinMismatch('PQRST5678K', '29ABCDE1234F1Z5')).toBe(true);
  });

  it('is never raised for a seller without a GSTIN — it is optional', () => {
    expect(panGstinMismatch('ABCDE1234F', null)).toBe(false);
    expect(panGstinMismatch('ABCDE1234F', '')).toBe(false);
  });

  it('is not raised on a typo in either ID; that is a format problem, reported as one', () => {
    expect(panGstinMismatch('ABCDE1234', '29ABCDE1234F1Z5')).toBe(false);
    expect(panGstinMismatch('ABCDE1234F', '29ABCDE12')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function view(check: KycCheckView['check'], over: Partial<KycCheckView> = {}): KycCheckView {
  return {
    check,
    state: 'VERIFIED',
    reason: null,
    nameScore: check === 'GSTIN' ? null : 100,
    nameBand: check === 'GSTIN' ? null : 'DIRECT_MATCH',
    nameMeetsThreshold: check === 'GSTIN' ? null : true,
    provider: 'cashfree',
    checkedAt: '2026-09-18T10:00:00.000Z',
    ...over,
  };
}

function summary(over: Partial<SellerKycSummary> = {}): SellerKycSummary {
  return {
    pan: view('PAN'),
    gstin: view('GSTIN'),
    bank: view('BANK'),
    panGstinMismatch: false,
    panOnFile: null,
    panInGstin: null,
    fraudAccount: false,
    nameMatchThreshold: 85,
    ...over,
  };
}

describe('approval warnings', () => {
  it('are empty when every check passed', () => {
    expect(kycApprovalWarnings(summary())).toEqual([]);
  });

  it('say nothing about a missing GSTIN — sellers under the threshold have none', () => {
    const s = summary({ gstin: view('GSTIN', { state: 'NOT_PROVIDED', checkedAt: null }) });
    expect(kycApprovalWarnings(s)).toEqual([]);
  });

  it('name both PANs in a mismatch, and call it a fraud signal', () => {
    const s = summary({ panGstinMismatch: true, panOnFile: 'PQRST5678K', panInGstin: 'ABCDE1234F' });
    const [first] = kycApprovalWarnings(s);
    expect(first).toContain('PQRST5678K');
    expect(first).toContain('ABCDE1234F');
    expect(first).toContain('fraud signal');
  });

  it('give the score, the band and the threshold for a weak name match', () => {
    const s = summary({
      pan: view('PAN', { nameScore: 62, nameBand: 'MODERATE_PARTIAL_MATCH', nameMeetsThreshold: false }),
    });
    expect(kycApprovalWarnings(s)).toEqual([
      'PAN name match is 62 (Moderate partial match), below the threshold of 85.',
    ]);
  });

  it('name the check and the reason when one failed', () => {
    const s = summary({ gstin: view('GSTIN', { state: 'FAILED', reason: 'GSTIN_INACTIVE' }) });
    expect(kycApprovalWarnings(s)).toEqual(['GSTIN verification failed: GSTIN is not active.']);
  });

  it('say a check that could not complete needs re-running, not that it failed', () => {
    const s = summary({ bank: view('BANK', { state: 'ERROR', reason: 'BANK_UNAVAILABLE', nameScore: null }) });
    const [w] = kycApprovalWarnings(s);
    expect(w).toContain('Bank account check could not complete');
    expect(w).toContain('re-run');
  });

  it('say which checks were never run', () => {
    const s = summary({
      pan: view('PAN', { state: 'NOT_RUN', reason: 'NAME_MISSING', nameScore: null }),
      bank: view('BANK', { state: 'NOT_RUN', nameScore: null }),
    });
    expect(kycApprovalWarnings(s)).toEqual([
      'PAN has not been verified: the name to check against is missing.',
      'Bank account has not been verified yet.',
    ]);
  });

  it('flag a bank account whose holder name was never checked', () => {
    const s = summary({ bank: view('BANK', { nameScore: null, nameBand: null, nameMeetsThreshold: null }) });
    expect(kycApprovalWarnings(s)).toEqual([
      'Bank account is valid, but the account holder name was not checked.',
    ]);
  });

  it('report a fraud-flagged account once, not also as a failed check', () => {
    const s = summary({
      fraudAccount: true,
      bank: view('BANK', { state: 'FAILED', reason: 'FRAUD_ACCOUNT', nameScore: null }),
    });
    expect(kycApprovalWarnings(s)).toEqual([
      'Bank account is flagged as fraudulent by the verification provider.',
    ]);
  });
});

describe("the seller's own view", () => {
  it('carries no scores or bands — nothing to tune a borrowed name against', () => {
    const status = toSellerKycStatus(
      summary({ pan: view('PAN', { nameScore: 40, nameBand: 'POOR_PARTIAL_MATCH', nameMeetsThreshold: false }) }),
    );
    expect(JSON.stringify(status)).not.toContain('40');
    expect(JSON.stringify(status)).not.toContain('POOR');
    expect(status.pan.nameNeedsReview).toBe(true);
  });

  it('offers verification while something is unchecked or errored', () => {
    expect(toSellerKycStatus(summary()).canVerify).toBe(false);
    expect(toSellerKycStatus(summary({ bank: view('BANK', { state: 'ERROR' }) })).canVerify).toBe(true);
    expect(toSellerKycStatus(summary({ pan: view('PAN', { state: 'NOT_RUN' }) })).canVerify).toBe(true);
  });
});
