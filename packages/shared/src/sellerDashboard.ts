// ---------------------------------------------------------------------------
// Seller dashboard
//
// Everything here is computed from the seller's own order lines, products,
// reviews and payouts. The KPIs compare against the immediately preceding
// window of the same length, so "vs previous" always means like for like.
// ---------------------------------------------------------------------------

export const SELLER_DASH_RANGES = ['TODAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;
export type SellerDashRange = (typeof SELLER_DASH_RANGES)[number];

export const SELLER_DASH_RANGE_LABELS: Record<SellerDashRange, string> = {
  TODAY: 'Today',
  WEEK: 'Last 7 days',
  MONTH: 'This month',
  QUARTER: 'Last 90 days',
  YEAR: 'This year',
};

export const SALES_GRANULARITIES = ['DAILY', 'WEEKLY'] as const;
export type SalesGranularity = (typeof SALES_GRANULARITIES)[number];

export const SALES_GRANULARITY_LABELS: Record<SalesGranularity, string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
};

export interface SellerMetric {
  value: number;
  previous: number;
  /** Null when the previous window had nothing to compare against. */
  changePercent: number | null;
}

// --- Store health -----------------------------------------------------------

export const HEALTH_GRADES = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR'] as const;
export type HealthGrade = (typeof HEALTH_GRADES)[number];

export const HEALTH_GRADE_LABELS: Record<HealthGrade, string> = {
  EXCELLENT: 'Excellent',
  GOOD: 'Good',
  FAIR: 'Needs work',
  POOR: 'At risk',
};

/**
 * A store-health metric with the bands that graded it, so the seller can see
 * why they got the grade rather than being handed a number.
 */
export interface HealthMetric {
  key: string;
  label: string;
  /** The measured value, already a percentage. */
  percent: number;
  grade: HealthGrade;
  /** True when a lower number is better (defects, cancellations, returns). */
  lowerIsBetter: boolean;
  /** Thresholds in grade order, for the tooltip. */
  bands: { grade: HealthGrade; upTo: number }[];
  /** What the percentage was measured over, e.g. "of 128 delivered items". */
  basis: string;
  /** Null when there is nothing to measure yet. */
  measurable: boolean;
}

export interface SellerDashboard {
  range: { key: SellerDashRange; label: string; from: string; to: string };
  store: {
    shopName: string;
    sellerCode: string;
    slug: string | null;
    status: string;
    logoUrl: string | null;
  };
  kpis: {
    /** Gross merchandise value of the seller's lines, before platform fees. */
    salesPaise: SellerMetric;
    orders: SellerMetric;
    unitsSold: SellerMetric;
    /** What the seller actually keeps once commission, gateway and TDS come off. */
    netRevenuePaise: SellerMetric;
    /** Paid lines waiting to be packed or shipped — work to do right now. */
    pendingOrders: number;
    rating: { average: number | null; count: number; changeVsPrevious: number | null };
  };
  salesTrend: { date: string; salesPaise: number; orders: number }[];
  orderStatus: { key: string; label: string; count: number; share: number }[];
  topCategories: {
    id: string;
    name: string;
    unitsSold: number;
    salesPaise: number;
    share: number;
  }[];
  recentOrders: {
    id: string;
    orderNumber: string;
    customerName: string;
    amountPaise: number;
    status: string;
    statusLabel: string;
    itemCount: number;
    createdAt: string;
  }[];
  productPerformance: {
    id: string;
    title: string;
    slug: string;
    imageUrl: string | null;
    unitsSold: number;
    salesPaise: number;
  }[];
  payouts: {
    /** Everything ever settled to the seller's bank. */
    lifetimePaidPaise: number;
    /** Settled within the current calendar month. */
    thisMonthPaise: number;
    /** Cleared the return window and ready to withdraw. */
    availablePaise: number;
    /** Delivered but still inside the return window. */
    inClearingPaise: number;
    /** When the oldest clearing line becomes withdrawable. */
    nextClearingAt: string | null;
    minWithdrawalPaise: number;
    canWithdraw: boolean;
    /** Why the withdraw button is disabled, when it is. */
    blockedReason: string | null;
  };
  health: {
    /** Simple average of the four graded metrics, 0–100. */
    scorePercent: number | null;
    metrics: HealthMetric[];
  };
  /** Things worth acting on today, each derived from real records. */
  actions: { key: string; label: string; count: number; href: string; tone: 'INFO' | 'WARN' }[];
}
