/** Where a payout goes: a saved beneficiary at the provider, or the details to save one. */
export interface PayoutBeneficiary {
  /** Our id for it at the provider (letters, digits, underscore). */
  id: string;
  name: string;
  accountNumber?: string | null;
  ifsc?: string | null;
  vpa?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface PayoutTransferRequest {
  /** Our id for this transfer at the provider, fixed per payout: a resend is the same transfer. */
  transferId: string;
  reference: string; // our payout reference (PAYOUT-000024)
  amountPaise: number;
  /** Human label of the destination, e.g. "HDFC Bank ••••5678". */
  destination: string;
  beneficiaryId?: string | null;
  mode: 'banktransfer' | 'upi';
  ifsc?: string | null;
  upiId?: string | null;
}

export interface PayoutTransfer {
  /** PAID: credited. PROCESSING: on its way, final later. FAILED: never left. REVERSED: the bank sent it back. */
  status: 'PROCESSING' | 'PAID' | 'FAILED' | 'REVERSED';
  /** Bank/UPI reference for the credit, once there is one. */
  utr?: string | null;
  providerTransferId?: string | null;
  /** The provider's own words (Cashfree: status/status_code). */
  providerStatus?: string | null;
  failureReason?: string;
}

/** The Payouts account's money, in paise. */
export interface PayoutBalance {
  /** Everything in the account. */
  balancePaise: number;
  /** What can be sent now: the balance less transfers still in flight. */
  availablePaise: number;
}

export interface PayoutVerification {
  verified: boolean;
  /** Name the bank returned for the account, when the check supports it. */
  accountName?: string;
  reason?: string;
}

/**
 * Payouts abstraction. The mock settles instantly in dev; Cashfree Payouts
 * (v2) sends real transfers and reports their outcome later.
 */
export interface PayoutProvider {
  readonly name: string;
  /** Register (or confirm) a beneficiary before the first transfer to it. Returns its id. */
  ensureBeneficiary?(beneficiary: PayoutBeneficiary): Promise<string>;
  transfer(request: PayoutTransferRequest): Promise<PayoutTransfer>;
  /** A transfer's current state by our transfer id; null if the provider never received it. */
  getTransfer?(transferId: string): Promise<PayoutTransfer | null>;
  /** The account's balance (read-only). Absent on providers with no account to fund (the mock). */
  getBalance?(): Promise<PayoutBalance>;
  /** Penny-drop style check before money is ever sent to a new account. */
  verifyMethod(input: { accountLast4?: string | null; ifsc?: string | null; upiId?: string | null }): Promise<PayoutVerification>;
}
