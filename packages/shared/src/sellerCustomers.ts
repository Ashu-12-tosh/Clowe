// ---------------------------------------------------------------------------
// Seller CRM
//
// A marketplace seller doesn't own customer records — every customer here is
// derived from orders placed with this shop, so the numbers are always the
// seller's own slice of that shopper's activity.
// ---------------------------------------------------------------------------

export const CUSTOMER_SEGMENTS = ['HIGH_VALUE', 'REPEAT', 'REGULAR', 'AT_RISK', 'NEW'] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];

export const CUSTOMER_SEGMENT_LABELS: Record<CustomerSegment, string> = {
  HIGH_VALUE: 'High value',
  REPEAT: 'Repeat',
  REGULAR: 'Regular',
  AT_RISK: 'At risk',
  NEW: 'New',
};

/** Plain-English rule behind each segment, shown in the UI. */
export const CUSTOMER_SEGMENT_RULES: Record<CustomerSegment, string> = {
  HIGH_VALUE: 'Lifetime spend in the top 20% of your customers',
  REPEAT: 'Two or more orders from your shop',
  REGULAR: 'Ordered before, outside the other segments',
  AT_RISK: 'No order in the last 90 days',
  NEW: 'First order in the last 30 days',
};

export const CUSTOMER_STATUSES = ['ACTIVE', 'AT_RISK', 'DORMANT'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  ACTIVE: 'Active',
  AT_RISK: 'At risk',
  DORMANT: 'Dormant',
};

export const CUSTOMER_SORTS = ['LTV_HIGH', 'LTV_LOW', 'ORDERS_HIGH', 'RECENT', 'OLDEST'] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export const CUSTOMER_SORT_LABELS: Record<CustomerSort, string> = {
  LTV_HIGH: 'Lifetime value: high to low',
  LTV_LOW: 'Lifetime value: low to high',
  ORDERS_HIGH: 'Most orders',
  RECENT: 'Recently ordered',
  OLDEST: 'Longest-standing',
};

export interface SellerCustomerRow {
  userId: string;
  name: string;
  email: string | null;
  phone: string;
  /** Most recent shipping city seen on their orders. */
  city: string | null;
  state: string | null;
  segment: CustomerSegment;
  segmentLabel: string;
  status: CustomerStatus;
  statusLabel: string;
  orderCount: number;
  unitsBought: number;
  /** Lifetime value with THIS shop, net of cancelled/returned lines. */
  ltvPaise: number;
  avgOrderValuePaise: number;
  firstOrderAt: string;
  lastOrderAt: string;
  daysSinceLastOrder: number;
  returnCount: number;
  /** 0–100 share of their units that came back. */
  returnRate: number;
}

export interface SellerCustomerPage {
  rows: SellerCustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SellerCustomerDetail extends SellerCustomerRow {
  joinedAt: string;
  orders: {
    orderId: string;
    orderNumber: string;
    placedAt: string;
    status: string;
    itemCount: number;
    amountPaise: number;
  }[];
  /** What they buy from you, by spend. */
  topCategories: { name: string; unitsBought: number; spentPaise: number }[];
  topProducts: { productId: string; title: string; unitsBought: number; spentPaise: number }[];
  returns: {
    id: string;
    orderNumber: string;
    title: string;
    reasonLabel: string;
    status: string;
    requestedAt: string;
  }[];
}

export interface SellerCustomerSummary {
  kpis: {
    total: number;
    totalChangePercent: number | null;
    newThisMonth: number;
    newChangePercent: number | null;
    repeat: number;
    repeatRate: number;
    avgLtvPaise: number;
    orders: number;
    returnRate: number;
  };
  segments: { key: CustomerSegment; label: string; rule: string; count: number; share: number }[];
  /** How many customers sit in each order-count bucket. */
  frequency: { key: string; label: string; count: number; share: number }[];
  topCities: { city: string; count: number; share: number }[];
  topCustomers: {
    userId: string;
    name: string;
    orderCount: number;
    ltvPaise: number;
  }[];
  insights: { key: string; tone: 'GOOD' | 'INFO' | 'WARN'; title: string; body: string }[];
  /** Lifetime-spend cut-off for the high-value segment. */
  highValueThresholdPaise: number;
}
