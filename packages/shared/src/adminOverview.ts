// ---------------------------------------------------------------------------
// Admin dashboard overview
// ---------------------------------------------------------------------------

export const OVERVIEW_RANGES = ['TODAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];

export const OVERVIEW_RANGE_LABELS: Record<OverviewRange, string> = {
  TODAY: 'Today',
  WEEK: 'Last 7 days',
  MONTH: 'This month',
  QUARTER: 'Last 90 days',
  YEAR: 'This year',
};

export interface OverviewMetric {
  value: number;
  previous: number;
  changePercent: number | null;
}

export interface AdminOverview {
  range: { key: OverviewRange; label: string; from: string; to: string };
  kpis: {
    gmvPaise: OverviewMetric;
    orders: OverviewMetric;
    users: OverviewMetric;
    activeSellers: OverviewMetric;
    products: OverviewMetric;
    /** What the marketplace keeps: commission + gateway fees on delivered sales. */
    revenuePaise: OverviewMetric;
  };
  /** Daily GMV and order counts across the range. */
  salesTrend: { date: string; gmvPaise: number; orders: number }[];
  orderStatus: { key: string; label: string; count: number; share: number }[];
  topCategories: { id: string; name: string; gmvPaise: number; share: number }[];
  recentOrders: {
    id: string;
    orderNumber: string;
    customerName: string;
    sellerNames: string[];
    amountPaise: number;
    paymentStatus: string;
    status: string;
    createdAt: string;
  }[];
  newSellers: {
    id: string;
    shopName: string;
    email: string | null;
    status: string;
    joinedAt: string;
  }[];
  topSellers: {
    id: string;
    shopName: string;
    gmvPaise: number;
    orders: number;
    ratingAvg: number | null;
  }[];
  tryOn: {
    sessions: number;
    sessionsChangePercent: number | null;
    successful: number;
    /** Share of try-on viewers who went on to order that product. */
    conversionRate: number;
    trend: { date: string; count: number }[];
  };
  /** Live probes, not decoration — each one is checked when this loads. */
  systemHealth: {
    overall: 'OPERATIONAL' | 'DEGRADED' | 'DOWN';
    checks: { key: string; label: string; status: string; detail: string }[];
  };
  /** Signals worth a human look, each one derived from real records. */
  riskAlerts: {
    key: string;
    label: string;
    count: number;
    detail: string;
    href: string;
  }[];
  platformSummary: {
    users: number;
    sellers: number;
    products: number;
    orders: number;
    returns: number;
    revenuePaise: number;
  };
  pending: { sellers: number; products: number; tickets: number; returns: number; payouts: number };
}
