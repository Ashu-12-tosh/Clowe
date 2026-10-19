// ---------------------------------------------------------------------------
// Cash on Delivery refunds.
//
// A COD buyer paid in cash, so there is no online payment to refund to. The
// refund is a bank transfer to an account in the buyer's own name, on the
// account number and IFSC they give when they start the return (Return,
// Exchange and Refund Policy, clause 6.4) — never cash, never UPI. An admin
// pays it by hand and records the bank reference (UTR).
// ---------------------------------------------------------------------------
import { z } from 'zod';
import { IFSC_PATTERN, normalizeTaxId } from './kyc';

/** Indian bank account numbers run 9 to 18 digits. */
export const BANK_ACCOUNT_NUMBER_PATTERN = /^\d{9,18}$/;

export const codRefundAccountSchema = z.object({
  /** As on the bank account: it must be the buyer's own. */
  accountName: z
    .string()
    .trim()
    .min(3, 'Enter the name on the bank account')
    .max(100)
    .regex(/^[A-Za-z][A-Za-z .'-]*$/, 'Use letters only, as printed on your bank account'),
  accountNumber: z
    .string()
    .transform((v) => v.replace(/[\s-]+/g, ''))
    .pipe(z.string().regex(BANK_ACCOUNT_NUMBER_PATTERN, 'An account number is 9 to 18 digits')),
  ifsc: z
    .string()
    .transform(normalizeTaxId)
    .pipe(z.string().regex(IFSC_PATTERN, 'IFSC is 11 characters, like HDFC0001234')),
  /** The buyer confirms the account is in their own name. */
  ownAccount: z.literal(true, { errorMap: () => ({ message: 'The refund can only go to an account in your own name' }) }),
});
export type CodRefundAccountInput = z.infer<typeof codRefundAccountSchema>;

/** Only the last four characters, for every view but the one an admin pays from. */
export function maskLast4(value: string): string {
  const tail = value.slice(-4);
  return `${'•'.repeat(Math.max(4, value.length - 4))}${tail}`;
}

/** A COD refund waiting to be paid, or paid, as the admin list shows it. */
export interface CodRefundRow {
  refundId: string;
  returnId: string | null;
  rmaNumber: string | null;
  orderId: string;
  orderNumber: string;
  buyerName: string | null;
  buyerPhone: string;
  itemTitle: string | null;
  amountPaise: number;
  status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED';
  /** "••••••••1234" — the account number, masked. Null when the buyer gave none. */
  accountMasked: string | null;
  createdAt: string;
  paidAt: string | null;
  reference: string | null;
}

/** The full details, for the admin making the transfer: shown on request, and logged. */
export interface CodRefundAccountView {
  accountName: string;
  accountNumber: string;
  ifsc: string;
}

export const codRefundPaidSchema = z.object({
  /** The bank's reference for the transfer (UTR / IMPS / NEFT reference). */
  reference: z
    .string()
    .trim()
    .min(6, 'Enter the bank reference (UTR) of the transfer')
    .max(40)
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and dashes only'),
});
