export interface PayoutTransferRequest {
  reference: string; // our payout reference (PAYOUT-000024)
  amountPaise: number;
  /** Human label of the destination, e.g. "HDFC Bank ••••5678". */
  destination: string;
  ifsc?: string | null;
  upiId?: string | null;
}

export interface PayoutTransfer {
  /** Bank/UPI reference for the credit. */
  utr: string;
  status: 'PROCESSING' | 'PAID' | 'FAILED';
  failureReason?: string;
}

export interface PayoutVerification {
  verified: boolean;
  /** Name the bank returned for the account, when the check supports it. */
  accountName?: string;
  reason?: string;
}

/**
 * RazorpayX-style payouts abstraction. The mock settles instantly in dev; a
 * real provider (RazorpayX / Cashfree Payouts) slots in behind this interface.
 */
export interface PayoutProvider {
  readonly name: string;
  transfer(request: PayoutTransferRequest): Promise<PayoutTransfer>;
  /** Penny-drop style check before money is ever sent to a new account. */
  verifyMethod(input: { accountLast4?: string | null; ifsc?: string | null; upiId?: string | null }): Promise<PayoutVerification>;
}
