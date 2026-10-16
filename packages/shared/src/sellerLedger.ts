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
  'GT_CHARGE',
  'SELLER_CANCEL_PENALTY',
  'FORWARD_FREIGHT',
  'FREIGHT_ADJUSTMENT',
  'COD_FEE',
  'RTO_FREIGHT',
  'RETURN_FREIGHT',
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
  GT_CHARGE: 'GT charge',
  GST_TCS: 'GST TCS (s.52)',
  SELLER_CANCEL_PENALTY: 'Cancellation penalty',
  FORWARD_FREIGHT: 'Delhivery freight',
  FREIGHT_ADJUSTMENT: 'Freight adjustment',
  COD_FEE: 'COD fee (Delhivery)',
  RTO_FREIGHT: 'RTO freight (Delhivery)',
  RETURN_FREIGHT: 'Return pickup freight (Delhivery)',
};

/**
 * Who pays for a return's pickup, as Store Settings → Returns says it. The
 * seller does: the trip is charged to their ledger as RETURN_FREIGHT.
 */
export const RETURN_PICKUP_NOTE =
  `Return pickup is booked through Delhivery and paid for by you: when a return reaches you, Delhivery's charge for the trip ` +
  `is posted to your ledger as "${SELLER_LEDGER_TYPE_LABELS.RETURN_FREIGHT}". Decide on requests within 48 hours — see the Returns page.`;

/** The two penalties a seller can be charged, once per order each. */
export const PENALTY_KINDS = ['LATE_DISPATCH', 'SELLER_CANCEL'] as const;
export type PenaltyKind = (typeof PENALTY_KINDS)[number];
export const PENALTY_KIND_LABELS: Record<PenaltyKind, string> = {
  LATE_DISPATCH: 'Late dispatch',
  SELLER_CANCEL: 'Cancelled by seller',
};
/** The ledger type that charges each kind. */
export const PENALTY_LEDGER_TYPE: Record<PenaltyKind, SellerLedgerTypeValue> = {
  LATE_DISPATCH: 'LATE_DISPATCH_PENALTY',
  SELLER_CANCEL: 'SELLER_CANCEL_PENALTY',
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
    /** Set on order-level entries (a late-dispatch penalty) as well as per-line ones. */
    orderId: string | null;
    orderItemId: string | null;
    itemTitle: string | null;
    payoutReference: string | null;
    adId: string | null;
  };
  createdAt: string;
  /**
   * Which penalty a penalty or waiver row is about; null on every other row.
   * One order can carry both kinds, so a waiver is matched by kind and order.
   */
  penaltyKind: PenaltyKind | null;
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
  /** Charged once per order not dispatched by the deadline. */
  penaltyPaise: number;
  /** Hours after placement the penalty falls due. */
  afterHours: number;
  /** The dispatch promise, earlier than the penalty. */
  slaHours: number;
  /** Orders placed before this (ISO) are never charged; null when every order is. */
  effectiveFrom: string | null;
}

/** The seller-cancellation rule as the platform currently runs it. */
export interface SellerCancelRule {
  enabled: boolean;
  /** Charged once per order the seller cancels (not the buyer or an admin). */
  penaltyPaise: number;
  /** Orders placed before this (ISO) are never charged; null when every order is. */
  effectiveFrom: string | null;
}

/** One penalty and whether it was forgiven. */
export interface SellerPenaltyRow {
  /** The penalty's ledger entry. */
  entryId: string;
  kind: PenaltyKind;
  orderId: string | null;
  orderNumber: string | null;
  itemTitle: string | null;
  chargedAt: string;
  /** What was charged, as a positive number. */
  amountPaise: number;
  /** Why: the dispatch arithmetic, or the seller's cancellation reason. */
  reason: string | null;
  waived: boolean;
  waivedAt: string | null;
  /** The admin's reason, as recorded on the waiver. */
  waiverNote: string | null;
}

/** GET /api/seller/ledger/penalties. Always answers, even with no penalties. */
export interface SellerPenaltiesView {
  rule: LateDispatchRule;
  cancelRule: SellerCancelRule;
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
