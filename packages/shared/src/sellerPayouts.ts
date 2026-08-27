import { z } from 'zod';

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
    adjustmentsPaise: number;
    paidOutPaise: number;
    payablePaise: number;
  };
  fees: {
    commissionPaise: number;
    gatewayPaise: number;
    adjustmentsPaise: number;
    totalPaise: number;
  };
  /** Financial-year TDS position (India FY runs April–March). */
  tds: {
    financialYear: string;
    grossSalesPaise: number;
    tdsWithheldPaise: number;
    tdsDepositedPaise: number;
  };
  recentPayouts: SellerPayoutRow[];
  methods: SellerPayoutMethodRow[];
  insights: { key: string; tone: 'GOOD' | 'INFO' | 'WARN'; title: string; body: string }[];
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
