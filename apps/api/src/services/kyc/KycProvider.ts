import type { KycErrorReason, KycFailureReason, NameMatchBand } from '@clowe/shared';

/** The provider's name-match verdict. Its score, never one computed here. */
export interface NameMatch {
  /** 0–100. */
  score: number;
  band: NameMatchBand;
}

/**
 * The provider's definitive answer about one document.
 *
 * `status` is only about the document: does this PAN exist and is it active,
 * is this GSTIN registered and active, is this account open. A valid PAN whose
 * name matches poorly is still VERIFIED — the name match is reported beside it
 * and judged by the admin against a threshold, not collapsed into a pass/fail
 * that would have to be re-bought to change.
 */
export interface KycResult {
  status: 'VERIFIED' | 'FAILED';
  /** Why it FAILED; null when VERIFIED. */
  reason: KycFailureReason | null;
  /** null when no name was checked, or the check offers no name match (GSTIN). */
  nameMatch: NameMatch | null;
}

/**
 * No answer — the call did not produce a verdict. Carries our reason code and
 * a detail line for the server log, which holds the HTTP status and the
 * provider's error code only: never a request field, since those are PANs and
 * account numbers.
 *
 * The caller decides whether to try again. Providers never retry on their own:
 * a verification may already have been billed by the time it fails.
 */
export class KycProviderError extends Error {
  readonly reason: KycErrorReason;
  readonly detail: string;

  constructor(reason: KycErrorReason, detail: string) {
    super(`KYC provider error: ${reason}`);
    this.name = 'KycProviderError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Seller KYC verification. Implementations: MockKycProvider (free, dev) and
 * CashfreeKycProvider (Cashfree Verification Suite).
 *
 * Every call to a real provider costs money. Implementations make exactly one
 * request per call and never retry; caching, rate limiting and the decision to
 * retry all belong to the caller, which can see the history.
 */
export interface KycProvider {
  /** Stored against every result, so one provider's answers never stand in for another's. */
  readonly name: string;

  /** Whether the PAN exists and is active, and how well `name` matches the one on it. */
  verifyPAN(pan: string, name: string): Promise<KycResult>;

  /**
   * Whether the GSTIN is registered and active. `businessName` is accepted for
   * providers that can match it; Cashfree cannot, so it reports no name match.
   */
  verifyGSTIN(gstin: string, businessName?: string): Promise<KycResult>;

  /**
   * Whether the account is open and can receive money.
   *
   * `name` is required-but-nullable on purpose: a name match can be billed on
   * top of the verification, so every caller has to decide whether it needs
   * one. null asks for validity only.
   */
  verifyBank(accountNumber: string, ifsc: string, name: string | null): Promise<KycResult>;
}
