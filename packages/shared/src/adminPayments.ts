// ---------------------------------------------------------------------------
// Payment & transaction management (admin)
//
// The money in this app lives in four tables: Payment (shopper → platform),
// Refund (platform → shopper), Payout (platform → seller) and CreditPurchase
// (shopper buying credits). This screen is a single ledger over all four, plus
// the checks that prove they agree with the orders behind them.
// ---------------------------------------------------------------------------

export const TRANSACTION_TYPES = ['PAYMENT', 'REFUND', 'PAYOUT', 'CREDIT_PURCHASE'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  PAYMENT: 'Payment',
  REFUND: 'Refund',
  PAYOUT: 'Seller payout',
  CREDIT_PURCHASE: 'Credit purchase',
};

/**
 * One vocabulary across all four tables. Each source status maps into this so
 * the ledger can be filtered without knowing which table a row came from.
 */
export const TRANSACTION_STATUSES = ['SUCCESS', 'PENDING', 'FAILED', 'REFUNDED'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TRANSACTION_STATUS_LABELS: Record<TransactionStatus, string> = {
  SUCCESS: 'Success',
  PENDING: 'Pending',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
};

export const TRANSACTION_TABS = [
  'ALL',
  'SUCCESSFUL',
  'FAILED',
  'PENDING',
  'REFUNDED',
  'DISPUTED',
] as const;
export type TransactionTab = (typeof TRANSACTION_TABS)[number];

export const TRANSACTION_TAB_LABELS: Record<TransactionTab, string> = {
  ALL: 'All transactions',
  SUCCESSFUL: 'Successful',
  FAILED: 'Failed',
  PENDING: 'Pending',
  REFUNDED: 'Refunded',
  DISPUTED: 'Disputed',
};

export const TRANSACTION_SORTS = ['NEWEST', 'OLDEST', 'AMOUNT_HIGH', 'AMOUNT_LOW'] as const;
export type TransactionSort = (typeof TRANSACTION_SORTS)[number];

export const TRANSACTION_SORT_LABELS: Record<TransactionSort, string> = {
  NEWEST: 'Newest first',
  OLDEST: 'Oldest first',
  AMOUNT_HIGH: 'Amount: high to low',
  AMOUNT_LOW: 'Amount: low to high',
};

/** Money leaving the platform is shown as negative in the ledger. */
export const OUTGOING_TYPES: TransactionType[] = ['REFUND', 'PAYOUT'];

export interface TransactionRow {
  /** `${type}:${id}` — unique across the four source tables. */
  key: string;
  id: string;
  type: TransactionType;
  typeLabel: string;
  /** Gateway reference where there is one, otherwise the internal id. */
  reference: string;
  status: TransactionStatus;
  statusLabel: string;
  /** Raw status from the source table, for the drawer. */
  sourceStatus: string;
  amountPaise: number;
  /** True when the money left the platform (refund, payout). */
  outgoing: boolean;
  gateway: string;
  orderId: string | null;
  orderNumber: string | null;
  counterpartyName: string | null;
  counterpartySubtitle: string | null;
  sellerName: string | null;
  failureReason: string | null;
  /** Set when a shopper has an open payment complaint about this order. */
  disputed: boolean;
  createdAt: string;
}

export interface TransactionPage {
  rows: TransactionRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  tabCounts: Record<TransactionTab, number>;
}

export interface GatewayPerformance {
  gateway: string;
  transactions: number;
  successful: number;
  failed: number;
  successRate: number;
  amountPaise: number;
}

export interface RiskAlert {
  key: string;
  label: string;
  count: number;
  detail: string;
}

export interface AdminPaymentsSummary {
  range: { from: string; to: string; days: number };
  kpis: {
    totalTransactions: number;
    successfulPayments: number;
    failedPayments: number;
    refundsProcessed: number;
    gmvPaise: number;
    netPayoutsPaise: number;
    /** Previous-period comparison, null when there is no prior data. */
    changePercent: {
      totalTransactions: number | null;
      successfulPayments: number | null;
      failedPayments: number | null;
      gmvPaise: number | null;
    };
  };
  /** Payment rows only, by outcome — the "Payment overview" donut. */
  paymentOverview: {
    key: string;
    label: string;
    count: number;
    share: number;
    amountPaise: number;
  }[];
  /** Every ledger row by status — the "Transaction status distribution" donut. */
  statusDistribution: { key: string; label: string; count: number; share: number }[];
  gateways: GatewayPerformance[];
  riskAlerts: RiskAlert[];
  recentRefunds: {
    id: string;
    reference: string;
    orderNumber: string | null;
    amountPaise: number;
    status: string;
    createdAt: string;
  }[];
  gmvTrend: { date: string; gmvPaise: number; transactions: number }[];
  payouts: {
    paidPaise: number;
    pendingPaise: number;
    sellersPaid: number;
    byStatus: { key: string; label: string; count: number; share: number }[];
  };
  financials: {
    gmvPaise: number;
    commissionPaise: number;
    gatewayFeePaise: number;
    tdsPaise: number;
    refundsPaise: number;
    /** What the marketplace keeps once refunds are taken off. */
    netRevenuePaise: number;
  };
}

// --- Reconciliation ---------------------------------------------------------

export const RECONCILE_CHECKS = [
  'PAYMENT_AMOUNT_MISMATCH',
  'PAID_ORDER_WITHOUT_PAYMENT',
  'DELIVERED_COD_UNSETTLED',
  'REFUND_EXCEEDS_ORDER',
  'PAYOUT_MATH_MISMATCH',
  'STUCK_PROCESSING_PAYOUT',
  'ORPHAN_SUCCESSFUL_PAYMENT',
] as const;
export type ReconcileCheck = (typeof RECONCILE_CHECKS)[number];

export const RECONCILE_CHECK_LABELS: Record<ReconcileCheck, string> = {
  PAYMENT_AMOUNT_MISMATCH: 'Payment amount does not match the order total',
  PAID_ORDER_WITHOUT_PAYMENT: 'Order is past checkout with no payment row',
  DELIVERED_COD_UNSETTLED: 'COD order delivered but the cash was never settled',
  REFUND_EXCEEDS_ORDER: 'Refunds on an order exceed what was paid',
  PAYOUT_MATH_MISMATCH: 'Payout net does not equal gross minus its deductions',
  STUCK_PROCESSING_PAYOUT: 'Payout has been processing for over 24 hours',
  ORPHAN_SUCCESSFUL_PAYMENT: 'Payment succeeded but the order was cancelled without a refund',
};

export interface ReconcileFinding {
  check: ReconcileCheck;
  label: string;
  reference: string;
  orderNumber: string | null;
  detail: string;
  differencePaise: number;
}

export interface ReconcileReport {
  ranAt: string;
  checked: { payments: number; refunds: number; payouts: number; orders: number };
  findings: ReconcileFinding[];
  /** Counts per check, including the ones that came back clean. */
  byCheck: { check: ReconcileCheck; label: string; count: number }[];
}

export interface PaymentFilterOptions {
  gateways: string[];
  sellers: { id: string; name: string }[];
}
