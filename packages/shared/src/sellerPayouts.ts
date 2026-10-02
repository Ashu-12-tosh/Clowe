import { z } from 'zod';
import { KYC_REASON_LABELS, type KycCheckState, type KycReason } from './kyc';

// ---------------------------------------------------------------------------
// Seller payouts
//
// Sellers earn on delivery, the money is held for the return window, and the
// payout transfers it net of commission, gateway charges and 194-O TDS.
// ---------------------------------------------------------------------------

export const PAYOUT_STATUSES = ['PENDING', 'PROCESSING', 'PAID', 'FAILED'] as const;
export type PayoutStatusValue = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_STATUS_LABELS: Record<PayoutStatusValue, string> = {
  PENDING: 'Requested',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  FAILED: 'Failed',
};

export const PAYOUT_METHOD_TYPES = ['BANK', 'UPI'] as const;
export type PayoutMethodTypeValue = (typeof PAYOUT_METHOD_TYPES)[number];

export interface SellerPayoutMethodRow {
  id: string;
  type: PayoutMethodTypeValue;
  label: string;
  accountName: string;
  accountLast4: string | null;
  ifsc: string | null;
  upiId: string | null;
  isDefault: boolean;
  verified: boolean;
  createdAt: string;
}

export interface SellerPayoutRow {
  id: string;
  reference: string;
  periodFrom: string;
  periodTo: string;
  grossPaise: number;
  commissionPaise: number;
  gatewayPaise: number;
  feesPaise: number;
  adjustmentPaise: number;
  tdsPaise: number;
  /** GST TCS collected under s.52 on these lines. */
  tcsPaise: number;
  netPaise: number;
  status: PayoutStatusValue;
  methodLabel: string | null;
  utr: string | null;
  failureReason: string | null;
  requestedAt: string;
  processedAt: string | null;
  itemCount: number;
}

export interface SellerPayoutPage {
  rows: SellerPayoutRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** One settled line inside a payout (the "what was I paid for" view). */
export interface SellerPayoutLine {
  orderItemId: string;
  orderNumber: string;
  title: string;
  quantity: number;
  deliveredAt: string | null;
  grossPaise: number;
  commissionPaise: number;
  gatewayPaise: number;
  tdsPaise: number;
  tcsPaise: number;
  netPaise: number;
}

export interface SellerPayoutDetail extends SellerPayoutRow {
  lines: SellerPayoutLine[];
  adjustments: { id: string; placement: string; pricePaise: number; createdAt: string }[];
}

export interface SellerPayoutOverview {
  /** Fee/TDS rates in force, so the UI can explain every deduction. */
  rates: {
    commissionPercent: number;
    gatewayPercent: number;
    tdsPercent: number;
    platformFeePaise: number;
    deliveryFeePaise: number;
    closingFeePaise: number;
    minPayoutPaise: number;
    holdDays: number;
  };
  kpis: {
    /** Gross sales delivered in the selected month. */
    monthGrossPaise: number;
    monthGrossChangePercent: number | null;
    monthNetPaise: number;
    monthNetChangePercent: number | null;
    /** Cleared and ready to transfer right now. */
    payablePaise: number;
    inClearingPaise: number;
    nextClearingAt: string | null;
    lifetimePaidPaise: number;
    payoutCount: number;
    /** Share of finished payouts that succeeded, 0–100. */
    successRate: number;
  };
  /** Daily series over the selected month. */
  trend: { date: string; grossPaise: number; netPaise: number; feesPaise: number }[];
  /** Where the month's gross came from. */
  breakdown: { key: string; label: string; amountPaise: number; share: number }[];
  /** Reconciles opening balance → amount payable. */
  summary: {
    openingBalancePaise: number;
    earningsPaise: number;
    feesPaise: number;
    tdsPaise: number;
    tcsPaise: number;
    adjustmentsPaise: number;
    paidOutPaise: number;
    payablePaise: number;
  };
  fees: {
    commissionPaise: number;
    gatewayPaise: number;
    /** Platform, delivery and closing fees on the month's delivered lines. */
    fixedFeesPaise: number;
    adjustmentsPaise: number;
    totalPaise: number;
  };
  /** Financial-year TDS position (India FY runs April–March). */
  tds: {
    financialYear: string;
    grossSalesPaise: number;
    tdsWithheldPaise: number;
    tdsDepositedPaise: number;
    /** GST TCS (s.52) collected in the financial year; the seller claims it as credit. */
    tcsCollectedPaise: number;
  };
  recentPayouts: SellerPayoutRow[];
  methods: SellerPayoutMethodRow[];
  insights: { key: string; tone: 'GOOD' | 'INFO' | 'WARN'; title: string; body: string }[];
  /** Set while payouts are blocked for want of a verified PAN. */
  panBlock: PayoutPanBlock | null;
}

// ---------------------------------------------------------------------------
// A verified PAN before any payout
//
// TDS under section 194-O is deposited against the seller's PAN, and without
// one the rate is not ours to choose. So no money leaves without a PAN the
// provider has confirmed — whatever was decided at approval.
// ---------------------------------------------------------------------------

export interface PayoutPanBlock {
  code: 'PAN_NOT_VERIFIED';
  panState: KycCheckState;
  /** Why payouts are on hold, in the seller's terms. */
  reason: string;
  /** What to do about it. */
  action: string;
}

const WHERE = 'Store settings → Business';

/** Null when the PAN is verified; otherwise why payouts wait, and how to fix it. */
export function payoutPanBlock(pan: { state: KycCheckState; reason: KycReason | null }): PayoutPanBlock | null {
  const block = (reason: string, action: string): PayoutPanBlock => ({
    code: 'PAN_NOT_VERIFIED',
    panState: pan.state,
    reason,
    action,
  });
  const why = pan.reason ? KYC_REASON_LABELS[pan.reason] : null;
  switch (pan.state) {
    case 'VERIFIED':
      return null;
    case 'NOT_PROVIDED':
      return block(
        'There is no PAN on file.',
        `Add your PAN and the name printed on it in ${WHERE}, then press Verify.`,
      );
    case 'INVALID_FORMAT':
      return block(
        'The PAN on file is not a valid PAN (it looks like ABCDE1234F).',
        `Correct it in ${WHERE}, then press Verify.`,
      );
    case 'NOT_RUN':
      return pan.reason === 'NAME_MISSING'
        ? block(
            'Your PAN cannot be verified without the name printed on it.',
            `Add the name exactly as on your PAN card in ${WHERE}, then press Verify.`,
          )
        : block('Your PAN has not been verified yet.', `Press Verify in ${WHERE}.`);
    case 'ERROR':
      return block(
        `The PAN check could not complete${why ? ` (${why})` : ''}.`,
        `Press Verify again in ${WHERE}. If it keeps failing, contact seller support.`,
      );
    case 'FAILED':
      return block(
        `Your PAN could not be verified${why ? `: ${why}` : ''}.`,
        `Check the PAN and name in ${WHERE}, correct them and verify again, or contact seller support.`,
      );
  }
}

/** The error text when a payout is refused for want of a verified PAN. */
export function payoutPanMessage(block: PayoutPanBlock): string {
  return `Payouts need a verified PAN, because TDS is deposited against it. ${block.reason} ${block.action}`;
}

export const payoutRequestSchema = z.object({
  methodId: z.string().min(1).optional(),
});
export type PayoutRequestInput = z.infer<typeof payoutRequestSchema>;

export const payoutMethodCreateSchema = z
  .object({
    type: z.enum(PAYOUT_METHOD_TYPES).default('BANK'),
    label: z.string().trim().min(2, 'Give this method a name').max(40),
    accountName: z.string().trim().min(2, 'Account holder name is required').max(80),
    accountNumber: z
      .string()
      .trim()
      .regex(/^\d{6,18}$/, 'Account number looks wrong')
      .optional(),
    ifsc: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234')
      .optional(),
    upiId: z
      .string()
      .trim()
      .regex(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/, 'UPI ID looks like name@bank')
      .optional(),
    makeDefault: z.boolean().default(true),
  })
  .refine((v) => (v.type === 'BANK' ? !!v.accountNumber && !!v.ifsc : !!v.upiId), {
    message: 'Bank accounts need an account number and IFSC; UPI needs a UPI ID',
    path: ['accountNumber'],
  });
export type PayoutMethodCreateInput = z.infer<typeof payoutMethodCreateSchema>;
