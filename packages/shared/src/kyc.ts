// ---------------------------------------------------------------------------
// Seller KYC verification — PAN, GSTIN and bank account checks.
//
// The provider answers "is this document real and active"; a separate 0–100
// name-match score says how well the name on it matches the one the seller
// gave. The two are kept apart on purpose: a valid PAN with a poor name match
// is not a failed PAN, it is a judgement call, and the admin makes it against
// a threshold that can move without anything being verified twice.
//
// Aadhaar is deliberately absent. Clowe does not collect or store it.
// ---------------------------------------------------------------------------

/** Checked locally before any paid call, so a typo never costs money. */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
/** What the verification provider accepts: 6–40 letters and digits. */
export const BANK_ACCOUNT_PATTERN = /^[A-Z0-9]{6,40}$/;

/** Uppercase with every space removed — how IDs are compared and sent. */
export function normalizeTaxId(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/**
 * The PAN embedded in a GSTIN: characters 3–12.
 *
 * A GSTIN is issued against a PAN and carries it — two-digit state code, the
 * ten-character PAN, then entity number, "Z" and a check character. null when
 * the GSTIN is not well-formed.
 */
export function panFromGstin(gstin: string): string | null {
  const g = normalizeTaxId(gstin);
  return GSTIN_PATTERN.test(g) ? g.slice(2, 12) : null;
}

/**
 * True only when both IDs are present, both well-formed, and they disagree.
 *
 * A GSTIN that does not carry the seller's PAN belongs to somebody else. That
 * is a much stronger fraud signal than a failed check, which is often a typo,
 * so it is surfaced on its own rather than folded into a status.
 */
export function panGstinMismatch(pan: string | null, gstin: string | null): boolean {
  if (!pan || !gstin) return false;
  const p = normalizeTaxId(pan);
  const inGstin = panFromGstin(gstin);
  return PAN_PATTERN.test(p) && inGstin !== null && inGstin !== p;
}

// ---------------------------------------------------------------------------
// Name match
// ---------------------------------------------------------------------------

/** The provider's bands, best first. The score is its own — never recomputed here. */
export const NAME_MATCH_BANDS = [
  'DIRECT_MATCH',
  'GOOD_PARTIAL_MATCH',
  'MODERATE_PARTIAL_MATCH',
  'POOR_PARTIAL_MATCH',
  'NO_MATCH',
] as const;
export type NameMatchBand = (typeof NAME_MATCH_BANDS)[number];

export const NAME_MATCH_BAND_LABELS: Record<NameMatchBand, string> = {
  DIRECT_MATCH: 'Direct match',
  GOOD_PARTIAL_MATCH: 'Good partial match',
  MODERATE_PARTIAL_MATCH: 'Moderate partial match',
  POOR_PARTIAL_MATCH: 'Poor partial match',
  NO_MATCH: 'No match',
};

/** Where the admin threshold starts: "good partial" and better. */
export const DEFAULT_KYC_NAME_MATCH_MIN_SCORE = 85;

// ---------------------------------------------------------------------------
// Checks and outcomes
// ---------------------------------------------------------------------------

export const KYC_CHECK_TYPES = ['PAN', 'GSTIN', 'BANK'] as const;
export type KycCheckType = (typeof KYC_CHECK_TYPES)[number];

export const KYC_CHECK_LABELS: Record<KycCheckType, string> = {
  PAN: 'PAN',
  GSTIN: 'GSTIN',
  BANK: 'Bank account',
};

/** The provider's definitive "no". Billed, cached, and not asked again. */
export const KYC_FAILURE_REASONS = [
  'PAN_INVALID',
  'PAN_INACTIVE',
  'GSTIN_NOT_FOUND',
  'GSTIN_INACTIVE',
  'ACCOUNT_INVALID',
  'ACCOUNT_BLOCKED',
  'IFSC_INVALID',
  'NRE_ACCOUNT',
  'FRAUD_ACCOUNT',
] as const;
export type KycFailureReason = (typeof KYC_FAILURE_REASONS)[number];

/**
 * No answer at all — the provider or the bank could not give one. Nothing is
 * cached, and a retry is something a person chooses to do: every attempt may
 * be billed, so a retry loop on this is a bill, not resilience.
 */
export const KYC_ERROR_REASONS = [
  'PROVIDER_AUTH',
  'PROVIDER_BALANCE',
  'PROVIDER_BUSY',
  'PROVIDER_UNAVAILABLE',
  'BANK_UNAVAILABLE',
  'REQUEST_REJECTED',
  'NETWORK',
] as const;
export type KycErrorReason = (typeof KYC_ERROR_REASONS)[number];

/** Found before any call is made. */
export type KycLocalReason = 'NAME_MISSING';

export type KycReason = KycFailureReason | KycErrorReason | KycLocalReason;

export const KYC_REASON_LABELS: Record<KycReason, string> = {
  PAN_INVALID: 'PAN does not exist',
  PAN_INACTIVE: 'PAN is deleted or deactivated',
  GSTIN_NOT_FOUND: 'GSTIN does not exist',
  GSTIN_INACTIVE: 'GSTIN is not active',
  ACCOUNT_INVALID: 'account number is invalid',
  ACCOUNT_BLOCKED: 'account is blocked',
  IFSC_INVALID: 'IFSC is invalid',
  NRE_ACCOUNT: 'NRE accounts are not supported',
  FRAUD_ACCOUNT: 'account is flagged as fraudulent by the provider',
  PROVIDER_AUTH: 'the verification provider rejected our credentials',
  PROVIDER_BALANCE: 'the verification account is out of balance',
  PROVIDER_BUSY: 'the verification provider is busy',
  PROVIDER_UNAVAILABLE: 'the verification provider is unavailable',
  BANK_UNAVAILABLE: 'the bank could not be reached',
  REQUEST_REJECTED: 'the provider rejected the details as sent',
  NETWORK: 'the verification provider could not be reached',
  NAME_MISSING: 'the name to check against is missing',
};

/** Where one check stands, as the UI shows it. */
export type KycCheckState =
  /** The provider confirmed the document. Name match is judged separately. */
  | 'VERIFIED'
  /** The provider's definitive no. Not retried — the answer would not change. */
  | 'FAILED'
  /** No answer: provider or bank trouble. Retrying is a deliberate act. */
  | 'ERROR'
  /** Nothing to check. For GSTIN that is fine; it is optional. */
  | 'NOT_PROVIDED'
  /** Fails the format check, so it was never sent. */
  | 'INVALID_FORMAT'
  /** Details are there and have not been verified — or changed since. */
  | 'NOT_RUN';

export const KYC_CHECK_STATE_LABELS: Record<KycCheckState, string> = {
  VERIFIED: 'Verified',
  FAILED: 'Failed',
  ERROR: 'Could not complete',
  NOT_PROVIDED: 'Not provided',
  INVALID_FORMAT: 'Invalid format',
  NOT_RUN: 'Not verified',
};

/** One check as the admin sees it: everything stored, nothing raw. */
export interface KycCheckView {
  check: KycCheckType;
  state: KycCheckState;
  reason: KycReason | null;
  /** The provider's 0–100 name match; null when not requested, or not offered (GSTIN). */
  nameScore: number | null;
  nameBand: NameMatchBand | null;
  /** Whether nameScore clears the admin threshold; null when there is no score. */
  nameMeetsThreshold: boolean | null;
  provider: string | null;
  checkedAt: string | null;
}

export interface SellerKycSummary {
  pan: KycCheckView;
  gstin: KycCheckView;
  bank: KycCheckView;
  /** GSTIN characters 3–12 are not the PAN on file. See panGstinMismatch. */
  panGstinMismatch: boolean;
  /** Both PANs, so the mismatch can be stated rather than just flagged. */
  panOnFile: string | null;
  panInGstin: string | null;
  /** The provider flagged the bank account as fraudulent. */
  fraudAccount: boolean;
  nameMatchThreshold: number;
}

/** One check as the seller sees it — no scores, which would only teach a fraudster to tune a name. */
export interface SellerKycCheckView {
  check: KycCheckType;
  state: KycCheckState;
  reasonLabel: string | null;
  /** The name matched below the threshold: worth checking it is exactly as on the document. */
  nameNeedsReview: boolean;
  checkedAt: string | null;
}

export interface SellerKycStatus {
  pan: SellerKycCheckView;
  gstin: SellerKycCheckView;
  bank: SellerKycCheckView;
  panGstinMismatch: boolean;
  /** Something is waiting to be checked or can be retried. */
  canVerify: boolean;
}

/** Narrow the admin's view to the seller's. */
export function toSellerKycStatus(summary: SellerKycSummary): SellerKycStatus {
  const view = (c: KycCheckView): SellerKycCheckView => ({
    check: c.check,
    state: c.state,
    reasonLabel: c.reason ? KYC_REASON_LABELS[c.reason] : null,
    nameNeedsReview: c.nameMeetsThreshold === false,
    checkedAt: c.checkedAt,
  });
  const checks = [summary.pan, summary.gstin, summary.bank];
  return {
    pan: view(summary.pan),
    gstin: view(summary.gstin),
    bank: view(summary.bank),
    panGstinMismatch: summary.panGstinMismatch,
    canVerify: checks.some((c) => c.state === 'NOT_RUN' || c.state === 'ERROR'),
  };
}

/**
 * Every reason to hesitate before approving, each as a plain sentence naming
 * the check and what is wrong with it. Empty means nothing to warn about.
 *
 * This is the text of the approval confirmation, so a generic "some checks
 * failed" is not good enough: the admin should be able to decide from it.
 */
export function kycApprovalWarnings(summary: SellerKycSummary): string[] {
  const out: string[] = [];

  if (summary.panGstinMismatch) {
    out.push(
      `PAN–GSTIN mismatch: the GSTIN carries PAN ${summary.panInGstin}, but the PAN on file is ` +
        `${summary.panOnFile}. The GSTIN may belong to someone else — a strong fraud signal.`,
    );
  }
  if (summary.fraudAccount) {
    out.push('Bank account is flagged as fraudulent by the verification provider.');
  }

  for (const view of [summary.pan, summary.gstin, summary.bank]) {
    const label = KYC_CHECK_LABELS[view.check];
    const why = view.reason ? KYC_REASON_LABELS[view.reason] : null;
    switch (view.state) {
      case 'VERIFIED':
        if (view.nameMeetsThreshold === false && view.nameScore !== null && view.nameBand) {
          out.push(
            `${label} name match is ${view.nameScore} (${NAME_MATCH_BAND_LABELS[view.nameBand]}), ` +
              `below the threshold of ${summary.nameMatchThreshold}.`,
          );
        } else if (view.check === 'BANK' && view.nameScore === null) {
          out.push('Bank account is valid, but the account holder name was not checked.');
        }
        break;
      case 'FAILED':
        // The fraud flag already has its own line above.
        if (view.reason !== 'FRAUD_ACCOUNT') out.push(`${label} verification failed: ${why ?? 'no reason given'}.`);
        break;
      case 'ERROR':
        out.push(`${label} check could not complete (${why ?? 'unknown error'}) — re-run it before relying on it.`);
        break;
      case 'INVALID_FORMAT':
        out.push(`${label} on file is not in a valid format, so it was never verified.`);
        break;
      case 'NOT_PROVIDED':
        // GSTIN is optional: sellers under the registration threshold have none.
        if (view.check !== 'GSTIN') out.push(`${label} has not been provided.`);
        break;
      case 'NOT_RUN':
        out.push(
          view.reason === 'NAME_MISSING'
            ? `${label} has not been verified: ${why}.`
            : `${label} has not been verified yet.`,
        );
        break;
    }
  }
  return out;
}
