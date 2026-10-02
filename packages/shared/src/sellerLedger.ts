import { z } from 'zod';

// ---------------------------------------------------------------------------
// Seller ledger
//
// Every rupee that moves for a seller is one signed row. The settlement
// bucket is what a payout draws on; the promotion bucket holds credits that
// can be spent on placements but never withdrawn.
// ---------------------------------------------------------------------------

export const SELLER_LEDGER_TYPES = [
  'SALE_EARNING',
  'COMMISSION',
  'PLATFORM_FEE',
  'GATEWAY_FEE',
  'TDS',
  'LATE_DISPATCH_PENALTY',
  'PENALTY_WAIVER',
  'RETURN_REVERSAL',
  'PROMOTION_CREDIT_PURCHASE',
  'PROMOTION_CREDIT_SPEND',
  'PAYOUT',
  'ADJUSTMENT',
  'DELIVERY_FEE',
  'CLOSING_FEE',
  'GST_TCS',
] as const;
export type SellerLedgerTypeValue = (typeof SELLER_LEDGER_TYPES)[number];

export const SELLER_LEDGER_BUCKETS = ['SETTLEMENT', 'PROMOTION'] as const;
export type SellerLedgerBucketValue = (typeof SELLER_LEDGER_BUCKETS)[number];

export const SELLER_LEDGER_TYPE_LABELS: Record<SellerLedgerTypeValue, string> = {
  SALE_EARNING: 'Sale',
  COMMISSION: 'Commission',
  PLATFORM_FEE: 'Platform fee',
  GATEWAY_FEE: 'Payment gateway',
  TDS: 'TDS 194-O',
  LATE_DISPATCH_PENALTY: 'Late dispatch penalty',
  PENALTY_WAIVER: 'Penalty waived',
  RETURN_REVERSAL: 'Return',
  PROMOTION_CREDIT_PURCHASE: 'Credits purchased',
  PROMOTION_CREDIT_SPEND: 'Credits spent',
  PAYOUT: 'Payout',
  ADJUSTMENT: 'Adjustment',
  DELIVERY_FEE: 'Delivery fee',
  CLOSING_FEE: 'Closing fee',
  GST_TCS: 'GST TCS (s.52)',
};

/** One row of a seller's ledger as the API serves it. */
export interface SellerLedgerEntryRow {
  id: string;
  type: SellerLedgerTypeValue;
  bucket: SellerLedgerBucketValue;
  amountPaise: number;
  /** Balance of this bucket after this entry, oldest-first. */
  runningBalancePaise: number;
  note: string | null;
  reference: {
    orderNumber: string | null;
    orderItemId: string | null;
    itemTitle: string | null;
    payoutReference: string | null;
    adId: string | null;
  };
  createdAt: string;
}

export interface SellerLedgerPage {
  bucket: SellerLedgerBucketValue;
  balancePaise: number;
  rows: SellerLedgerEntryRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** The late-dispatch rule as the platform currently runs it, from settings. */
export interface LateDispatchRule {
  enabled: boolean;
  /** Charged once per order line shipped after the window. */
  penaltyPaise: number;
  windowHours: number;
}

/** One late-dispatch penalty and whether it was forgiven. */
export interface SellerPenaltyRow {
  /** The LATE_DISPATCH_PENALTY ledger entry. */
  entryId: string;
  orderId: string | null;
  orderNumber: string | null;
  itemTitle: string | null;
  chargedAt: string;
  /** What was charged, as a positive number. */
  amountPaise: number;
  /** Why: the dispatch arithmetic written when it was charged. */
  reason: string | null;
  waived: boolean;
  waivedAt: string | null;
  /** The admin's reason, as recorded on the waiver. */
  waiverNote: string | null;
}

/** GET /api/seller/ledger/penalties. Always answers, even with no penalties. */
export interface SellerPenaltiesView {
  rule: LateDispatchRule;
  rows: SellerPenaltyRow[];
  /** Penalties in `rows`, newest first, capped; `total` counts them all. */
  total: number;
  chargedPaise: number;
  waivedPaise: number;
  /** charged − waived: what penalties have cost, all time. */
  netPaise: number;
}

export const sellerLedgerQuerySchema = z.object({
  bucket: z.enum(SELLER_LEDGER_BUCKETS).default('SETTLEMENT'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(20),
});
export type SellerLedgerQuery = z.infer<typeof sellerLedgerQuerySchema>;
