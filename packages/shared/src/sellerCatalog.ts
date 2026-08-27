// ---------------------------------------------------------------------------
// Seller product dashboard (list, filters and catalogue KPIs)
// ---------------------------------------------------------------------------

/** What a shopper would actually see for this listing right now. */
export const LISTING_STATES = [
  'ACTIVE',
  'INACTIVE',
  'OUT_OF_STOCK',
  'PENDING',
  'DRAFT',
  'REJECTED',
] as const;
export type ListingState = (typeof LISTING_STATES)[number];

export const LISTING_STATE_LABELS: Record<ListingState, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  OUT_OF_STOCK: 'Out of stock',
  PENDING: 'In review',
  DRAFT: 'Draft',
  REJECTED: 'Rejected',
};

export const SELLER_PRODUCT_SORTS = [
  'NEWEST',
  'OLDEST',
  'PRICE_HIGH',
  'PRICE_LOW',
  'SALES',
  'VIEWS',
  'STOCK_LOW',
] as const;
export type SellerProductSort = (typeof SELLER_PRODUCT_SORTS)[number];

export const SELLER_PRODUCT_SORT_LABELS: Record<SellerProductSort, string> = {
  NEWEST: 'Newest first',
  OLDEST: 'Oldest first',
  PRICE_HIGH: 'Price: high to low',
  PRICE_LOW: 'Price: low to high',
  SALES: 'Best selling',
  VIEWS: 'Most viewed',
  STOCK_LOW: 'Stock: low to high',
};

export interface SellerProductRow {
  id: string;
  title: string;
  slug: string;
  brand: string | null;
  shortDescription: string | null;
  imageUrl: string | null;
  categoryId: string;
  categoryName: string;
  /** First variant's SKU — the one printed on labels for a single-variant listing. */
  sku: string;
  variantCount: number;
  totalStock: number;
  lowStockAlert: number;
  /** Cheapest variant price, and its MRP when there is one. */
  pricePaise: number;
  mrpPaise: number | null;
  status: string;
  rejectionReason: string | null;
  listingState: ListingState;
  isVisible: boolean;
  /** Lifetime detail-page views. */
  views: number;
  unitsSold: number;
  salesPaise: number;
  createdAt: string;
  updatedAt: string;
}

export interface SellerProductPage {
  rows: SellerProductRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SellerCatalogSummary {
  kpis: {
    total: number;
    totalChangePercent: number | null;
    active: number;
    outOfStock: number;
    lowStock: number;
    /** Views in the last 30 days, and the change vs the 30 before that. */
    views30d: number;
    viewsChangePercent: number | null;
    salesPaise: number;
    salesChangePercent: number | null;
  };
  statusBreakdown: { key: ListingState; label: string; count: number; share: number }[];
  topProducts: {
    id: string;
    title: string;
    slug: string;
    imageUrl: string | null;
    unitsSold: number;
    salesPaise: number;
    pricePaise: number;
  }[];
  /** Categories this seller actually lists in, for the filter dropdown. */
  categories: { id: string; name: string; count: number }[];
}
