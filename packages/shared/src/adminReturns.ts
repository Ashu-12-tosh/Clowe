import { z } from 'zod';
import { RETURN_REASONS, type ReturnReasonValue } from './checkout';

// ---------------------------------------------------------------------------
// Returns & refund management (admin)
//
// The return lifecycle is REQUESTED → APPROVED → (picked up) → RECEIVED → QC →
// REFUNDED, with REJECTED as the other terminal state. The seller drives it;
// the admin oversees every shop at once and can override a rejection.
// ---------------------------------------------------------------------------

export const ADMIN_RETURN_TABS = [
  'ALL',
  'PENDING_REVIEW',
  'APPROVED',
  'IN_TRANSIT',
  'QC',
  'REFUNDED',
  'REJECTED',
  'DISPUTED',
] as const;
export type AdminReturnTab = (typeof ADMIN_RETURN_TABS)[number];

export const ADMIN_RETURN_TAB_LABELS: Record<AdminReturnTab, string> = {
  ALL: 'All requests',
  PENDING_REVIEW: 'Pending review',
  APPROVED: 'Approved',
  IN_TRANSIT: 'In transit',
  QC: 'QC / received',
  REFUNDED: 'Refunded',
  REJECTED: 'Rejected',
  DISPUTED: 'Disputed',
};

/**
 * The stage a return is at. Richer than `ReturnStatus` because APPROVED splits
 * on whether the courier has collected the parcel yet.
 */
export const RETURN_STAGES = [
  'PENDING_REVIEW',
  'APPROVED',
  'IN_TRANSIT',
  'QC',
  'REFUNDED',
  'REJECTED',
] as const;
export type ReturnStage = (typeof RETURN_STAGES)[number];

export const RETURN_STAGE_LABELS: Record<ReturnStage, string> = {
  PENDING_REVIEW: 'Pending review',
  APPROVED: 'Awaiting pickup',
  IN_TRANSIT: 'In transit',
  QC: 'QC pending',
  REFUNDED: 'Refunded',
  REJECTED: 'Rejected',
};

// RETURN_REASONS / RETURN_REASON_LABELS live in ./checkout — the shopper picks
// them, so the admin desk reads the same list rather than keeping its own.

export const RETURN_RESOLUTIONS = ['REFUND', 'STORE_CREDIT'] as const;
export type ReturnResolutionValue = (typeof RETURN_RESOLUTIONS)[number];

export const RETURN_RESOLUTION_LABELS: Record<ReturnResolutionValue, string> = {
  REFUND: 'Refund to source',
  STORE_CREDIT: 'Clowe Credits',
};

export const ADMIN_RETURN_SORTS = [
  'NEWEST',
  'OLDEST',
  'AMOUNT_HIGH',
  'AMOUNT_LOW',
  'OLDEST_OPEN',
] as const;
export type AdminReturnSort = (typeof ADMIN_RETURN_SORTS)[number];

export const ADMIN_RETURN_SORT_LABELS: Record<AdminReturnSort, string> = {
  NEWEST: 'Newest first',
  OLDEST: 'Oldest first',
  AMOUNT_HIGH: 'Refund: high to low',
  AMOUNT_LOW: 'Refund: low to high',
  OLDEST_OPEN: 'Longest waiting',
};

// --- Rows -------------------------------------------------------------------

export interface AdminReturnRowItem {
  productId: string;
  title: string;
  imageUrl: string | null;
  size: string;
  color: string;
  sku: string;
  quantity: number;
}

export interface AdminReturnListRow {
  id: string;
  rmaNumber: string;
  orderId: string;
  orderNumber: string;
  customer: { id: string; name: string | null; email: string | null; phone: string };
  seller: { id: string; name: string };
  item: AdminReturnRowItem;
  reason: ReturnReasonValue;
  reasonLabel: string;
  reasonDetail: string;
  stage: ReturnStage;
  stageLabel: string;
  status: string;
  resolution: ReturnResolutionValue;
  resolutionLabel: string;
  refundAmountPaise: number;
  /** Set once a refund row exists for this return. */
  refundStatus: string | null;
  photos: string[];
  /** Rejected with no admin review yet — the shopper is owed an answer. */
  disputed: boolean;
  /** Hours since the request came in, for the "longest waiting" sort. */
  ageHours: number;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface AdminReturnPage {
  rows: AdminReturnListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  tabCounts: Record<AdminReturnTab, number>;
}

export interface AdminReturnDetail extends AdminReturnListRow {
  rejectionReason: string | null;
  receivedCondition: string | null;
  qcPassed: boolean | null;
  qcNote: string | null;
  adminOverrideAt: string | null;
  adminOverrideNote: string | null;
  timeline: { key: string; label: string; at: string | null; note: string | null }[];
  /** How often this shopper returns things — the real numbers, not a score. */
  customerHistory: {
    deliveredItems: number;
    returns: number;
    returnRatePercent: number;
    refundedPaise: number;
  };
  order: {
    totalPaise: number;
    paymentMethod: string;
    paymentStatus: string | null;
    placedAt: string;
    deliveredAt: string | null;
  };
}

// --- Summary ----------------------------------------------------------------

export interface ReturnRiskRow {
  userId: string;
  name: string | null;
  phone: string;
  deliveredItems: number;
  returns: number;
  returnRatePercent: number;
  refundedPaise: number;
  /** Which rules this shopper tripped — the score is just how many. */
  flags: string[];
}

export interface AdminReturnsSummary {
  kpis: {
    total: number;
    pendingReview: number;
    approved: number;
    inTransit: number;
    qc: number;
    refunded: number;
    rejected: number;
    refundedPaise: number;
    storeCreditPaise: number;
    /** Returned items as a share of delivered items, all time. */
    returnRatePercent: number;
    deliveredItems: number;
    changePercent: { total: number | null; refundedPaise: number | null };
  };
  stageDistribution: { key: string; label: string; count: number; share: number }[];
  reasonBreakdown: { key: string; label: string; count: number; share: number }[];
  resolutionBreakdown: { key: string; label: string; count: number; share: number }[];
  qcBreakdown: { key: string; label: string; count: number; share: number }[];
  trend: { date: string; returns: number; refundedPaise: number }[];
  topSellers: { id: string; name: string; returns: number; returnRatePercent: number }[];
  risk: {
    highRiskCustomers: number;
    disputedReturns: number;
    missingPhotoDamageClaims: number;
    lateRefunds: number;
    rows: ReturnRiskRow[];
  };
}

export interface ReturnPolicyView {
  platformWindowDays: number;
  sellers: { id: string; name: string; windowDays: number | null; effectiveDays: number }[];
}

export interface AdminReturnFilterOptions {
  sellers: { id: string; name: string }[];
}

// --- Inputs -----------------------------------------------------------------

export const ADMIN_RETURN_ACTIONS = [
  'APPROVE',
  'REJECT',
  'MARK_PICKED_UP',
  'MARK_RECEIVED',
  'REFUND',
  'OVERRIDE',
] as const;
export type AdminReturnAction = (typeof ADMIN_RETURN_ACTIONS)[number];

export const ADMIN_RETURN_ACTION_LABELS: Record<AdminReturnAction, string> = {
  APPROVE: 'Approve return',
  REJECT: 'Reject return',
  MARK_PICKED_UP: 'Mark picked up',
  MARK_RECEIVED: 'Mark received + QC',
  REFUND: 'Issue refund',
  OVERRIDE: 'Override rejection',
};

export const adminReturnActionSchema = z.object({
  action: z.enum(ADMIN_RETURN_ACTIONS),
  /** Required for REJECT and OVERRIDE. */
  note: z.string().trim().max(300).optional(),
  /** MARK_RECEIVED: did the item come back in a sellable state? */
  qcPassed: z.boolean().optional(),
  /** REFUND: pay to the original method or as Clowe Credits. */
  resolution: z.enum(RETURN_RESOLUTIONS).optional(),
});
export type AdminReturnActionInput = z.infer<typeof adminReturnActionSchema>;

export const adminReturnBulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'Select at least one return').max(100),
  action: z.enum(ADMIN_RETURN_ACTIONS),
  note: z.string().trim().max(300).optional(),
  qcPassed: z.boolean().optional(),
  resolution: z.enum(RETURN_RESOLUTIONS).optional(),
});
export type AdminReturnBulkInput = z.infer<typeof adminReturnBulkSchema>;

export interface AdminReturnBulkResult {
  applied: number;
  skipped: { id: string; rmaNumber: string; reason: string }[];
}

/** A goodwill refund an admin issues against an order with no return behind it. */
export const manualRefundSchema = z.object({
  orderId: z.string().min(1, 'Pick an order'),
  amountPaise: z.number().int().min(100, 'Refund at least ₹1').max(100_000_000),
  reason: z.string().trim().min(5, 'Say why this refund is being issued').max(300),
  resolution: z.enum(RETURN_RESOLUTIONS).default('REFUND'),
});
export type ManualRefundInput = z.infer<typeof manualRefundSchema>;

export const returnPolicySchema = z.object({
  platformWindowDays: z.number().int().min(1).max(90),
});
export type ReturnPolicyInput = z.infer<typeof returnPolicySchema>;
