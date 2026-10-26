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
    method: 'PROVIDER',
    decidedBy: null,
    rejectReason: null,
    providerCheck: null,
    canMarkVerified: false,
    verifyBlockedReason: null,
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
    reviewMode: 'PROVIDER',
    ...over,
  };
}

describe('approval warnings', () => {
  it('read a pending check from what the provider said about it', () => {
    const ev = (over: Partial<NonNullable<KycCheckView['providerCheck']>>) => ({
      outcome: 'VERIFIED' as const, reason: null, nameScore: 100, nameBand: 'DIRECT_MATCH' as const, nameMeetsThreshold: true,
      provider: 'cashfree', referenceId: '1', checkedAt: '2026-10-27T10:00:00.000Z', ...over,
    });
    const pending = (check: KycCheckView['check'], providerCheck: KycCheckView['providerCheck'], reason: KycCheckView['reason'] = null) =>
      kycApprovalWarnings(summary({ [check === 'BANK' ? 'bank' : check === 'PAN' ? 'pan' : 'gstin']: view(check, { state: 'PENDING_REVIEW', method: null, reason, providerCheck }) }));
    expect(pending('PAN', null)).toEqual(['PAN has not been checked with the verification provider yet.']);
    expect(pending('PAN', ev({}))).toEqual(['PAN passed the provider check and is waiting for an admin to mark it verified.']);
    expect(pending('PAN', ev({ outcome: 'FAILED', reason: 'PAN_INVALID' }), 'PAN_INVALID')).toEqual(['PAN verification failed: PAN does not exist.']);
    expect(pending('BANK', ev({ outcome: 'ERROR', reason: 'BANK_UNAVAILABLE' }), 'BANK_UNAVAILABLE')[0]).toMatch(/could not complete \(the bank could not be reached\)/);
    expect(pending('PAN', ev({ nameScore: 70, nameBand: 'MODERATE_PARTIAL_MATCH', nameMeetsThreshold: false }))[0]).toMatch(/name match is 70.*below the threshold of 85/);
    expect(pending('BANK', ev({ nameScore: null, nameBand: null, nameMeetsThreshold: null }))).toEqual(['Bank account is valid, but the account holder name was not checked.']);
  });

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

  it('never offers the seller a check to run — every check is billed, and an admin runs it', () => {
    expect(toSellerKycStatus(summary()).canVerify).toBe(false);
    expect(toSellerKycStatus(summary({ bank: view('BANK', { state: 'ERROR' }) })).canVerify).toBe(false);
    expect(toSellerKycStatus(summary({ pan: view('PAN', { state: 'PENDING_REVIEW' }) })).canVerify).toBe(false);
  });

  it('offers nothing to run under manual review — an admin checks the documents', () => {
    const manual = summary({ reviewMode: 'MANUAL', pan: view('PAN', { state: 'PENDING_REVIEW', method: null }) });
    expect(toSellerKycStatus(manual)).toMatchObject({ canVerify: false, reviewMode: 'MANUAL', pan: { state: 'PENDING_REVIEW' } });
  });

  it('carries an admin rejection and its reason to the seller', () => {
    const rejected = toSellerKycStatus(summary({ gstin: view('GSTIN', { state: 'REJECTED', method: 'MANUAL', rejectReason: 'Not active' }) }));
    expect(rejected.gstin).toMatchObject({ state: 'REJECTED', method: 'MANUAL', rejectReason: 'Not active' });
    expect(kycApprovalWarnings(summary({ gstin: view('GSTIN', { state: 'REJECTED', rejectReason: 'Not active' }) }))).toContain('GSTIN was rejected: Not active.');
  });
});

describe('payout blocks for an unverified GSTIN or bank account', () => {
  it('wait for review with nothing to do, say a rejection and its reason, and clear once verified', async () => {
    const { payoutBankBlock, payoutGstinVerificationBlock } = await import('./sellerPayouts');
    expect(payoutBankBlock({ state: 'VERIFIED' })).toBeNull();
    expect(payoutBankBlock({ state: 'NOT_PROVIDED' })).toMatchObject({ code: 'BANK_NOT_VERIFIED', action: expect.stringContaining('cancelled cheque') });
    expect(payoutBankBlock({ state: 'PENDING_REVIEW' })?.reason).toMatch(/waiting for Clowe/);
    expect(payoutBankBlock({ state: 'REJECTED', rejectReason: 'Name differs from the cheque' })?.reason).toMatch(/not accepted: Name differs/);
    expect(payoutGstinVerificationBlock({ state: 'VERIFIED' })).toBeNull();
    expect(payoutGstinVerificationBlock({ state: 'NOT_PROVIDED' })).toBeNull(); // its own GSTIN_REQUIRED block covers it
    expect(payoutGstinVerificationBlock({ state: 'PENDING_REVIEW' })).toMatchObject({ code: 'GSTIN_NOT_VERIFIED' });
  });
});
