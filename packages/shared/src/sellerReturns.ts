import type { ReturnReasonValue } from './checkout';

// ---------------------------------------------------------------------------
// Seller returns & refunds dashboard
// ---------------------------------------------------------------------------

export const RETURN_TABS = [
  'ALL',
  'REQUESTED',
  'APPROVED',
  'RECEIVED',
  'REFUNDED',
  'REJECTED',
] as const;
export type ReturnTab = (typeof RETURN_TABS)[number];

export const RETURN_TAB_LABELS: Record<ReturnTab, string> = {
  ALL: 'All returns',
  REQUESTED: 'Pending approval',
  APPROVED: 'Approved',
  RECEIVED: 'In transit / received',
  REFUNDED: 'Refunded',
  REJECTED: 'Rejected',
};

export const RETURN_STATUS_LABELS: Record<string, string> = {
  REQUESTED: 'Pending approval',
  APPROVED: 'Approved',
  RECEIVED: 'Received',
  REJECTED: 'Rejected',
  REFUNDED: 'Refunded',
};

export const SELLER_RETURN_SORTS = ['NEWEST', 'OLDEST', 'AMOUNT_HIGH', 'AMOUNT_LOW'] as const;
export type SellerReturnSort = (typeof SELLER_RETURN_SORTS)[number];

export const SELLER_RETURN_SORT_LABELS: Record<SellerReturnSort, string> = {
  NEWEST: 'Newest first',
  OLDEST: 'Oldest first',
  AMOUNT_HIGH: 'Refund: high to low',
  AMOUNT_LOW: 'Refund: low to high',
};

export interface SellerReturnListRow {
  id: string;
  /** Human reference, e.g. RTN-20260803-4F2A. */
  reference: string;
  orderItemId: string;
  orderId: string;
  orderNumber: string;
  orderedAt: string;
  customerName: string;
  customerEmail: string | null;
  title: string;
  size: string;
  color: string;
  variantLabel: string;
  quantity: number;
  imageUrl: string | null;
  reason: ReturnReasonValue;
  reasonLabel: string;
  details: string | null;
  photos: string[];
  status: string;
  statusLabel: string;
  rejectionReason: string | null;
  receivedCondition: string | null;
  adminOverrideAt: string | null;
  /** What the shopper paid for this line — the refund amount. */
  refundAmountPaise: number;
  refund: { status: string; amountPaise: number; providerRefundId: string | null } | null;
  /** COD orders refund to wallet/bank; prepaid go back to the original method. */
  refundRoute: string;
  requestedAt: string;
  resolvedAt: string | null;
  /** Actions the seller can take right now. */
  canApprove: boolean;
  canReject: boolean;
  canMarkReceived: boolean;
}

export interface SellerReturnPage {
  rows: SellerReturnListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SellerReturnSummary {
  kpis: {
    requests: number;
    requestsChangePercent: number | null;
    approved: number;
    inTransit: number;
    refunded: number;
    refundedValuePaise: number;
    rejected: number;
    /** Returned units ÷ delivered units, 0–100. */
    returnRate: number;
    returnRateChange: number | null;
  };
  /** Status split for the overview donut. */
  statusBreakdown: { key: string; label: string; count: number; share: number }[];
  /** Why shoppers send things back, most common first. */
  topReasons: { key: ReturnReasonValue; label: string; count: number; share: number }[];
  /** Products generating the most returns. */
  topProducts: { productId: string; title: string; count: number; valuePaise: number }[];
  policy: {
    returnWindowDays: number;
    refundBusinessDays: string;
    returnShipping: string;
    /** Requests older than this with no decision are overdue. */
    decisionSlaHours: number;
    overdueCount: number;
  };
  counts: Record<ReturnTab, number>;
}
