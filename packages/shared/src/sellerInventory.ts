import { z } from 'zod';

// ---------------------------------------------------------------------------
// Seller inventory
//
// Stock lives on the variant, so this dashboard works one level below the
// product list: every row is a sellable unit with its own SKU and count.
// ---------------------------------------------------------------------------

export const STOCK_STATES = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'] as const;
export type StockState = (typeof STOCK_STATES)[number];

export const STOCK_STATE_LABELS: Record<StockState, string> = {
  IN_STOCK: 'In stock',
  LOW_STOCK: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
};

export const INVENTORY_SORTS = [
  'STOCK_LOW',
  'STOCK_HIGH',
  'UPDATED',
  'SALES',
  'VALUE_HIGH',
] as const;
export type InventorySort = (typeof INVENTORY_SORTS)[number];

export const INVENTORY_SORT_LABELS: Record<InventorySort, string> = {
  STOCK_LOW: 'Stock: low to high',
  STOCK_HIGH: 'Stock: high to low',
  UPDATED: 'Recently updated',
  SALES: 'Best selling',
  VALUE_HIGH: 'Stock value: high to low',
};

export interface InventoryRow {
  variantId: string;
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  categoryName: string;
  sku: string;
  size: string;
  color: string;
  pricePaise: number;
  mrpPaise: number | null;
  stock: number;
  /** Per-product threshold the seller set on the listing. */
  lowStockAlert: number;
  stockState: StockState;
  stockStateLabel: string;
  /** stock × price — what's sitting on the shelf. */
  stockValuePaise: number;
  allowBackorders: boolean;
  /** Units of this variant sold, and how many are committed to open orders. */
  unitsSold: number;
  reservedUnits: number;
  productStatus: string;
  isVisible: boolean;
  updatedAt: string;
}

export interface InventoryPage {
  rows: InventoryRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface InventorySummary {
  kpis: {
    variants: number;
    products: number;
    inStock: number;
    lowStock: number;
    outOfStock: number;
    totalUnits: number;
    /** Retail value of everything on the shelf. */
    stockValuePaise: number;
    /** Units committed to orders that haven't shipped yet. */
    reservedUnits: number;
  };
  stockBreakdown: { key: StockState; label: string; count: number; share: number }[];
  /** Variants that need restocking soonest. */
  restockList: {
    variantId: string;
    productId: string;
    title: string;
    sku: string;
    size: string;
    color: string;
    stock: number;
    lowStockAlert: number;
    unitsSold: number;
  }[];
  topSellers: {
    productId: string;
    title: string;
    imageUrl: string | null;
    unitsSold: number;
    salesPaise: number;
    stock: number;
  }[];
  /** Views → orders, for the performance panel. */
  performance: {
    views30d: number;
    unitsSold30d: number;
    conversionRate: number;
    avgOrderValuePaise: number;
  };
  categories: { id: string; name: string; count: number }[];
}

/** Absolute set, or a relative +/- adjustment. */
export const stockUpdateSchema = z.object({
  variantId: z.string().min(1),
  /** Exactly one of these. */
  stock: z.number().int().min(0).max(1000000).optional(),
  delta: z.number().int().min(-1000000).max(1000000).optional(),
});
export type StockUpdateInput = z.infer<typeof stockUpdateSchema>;

export const stockBulkSchema = z.object({
  updates: z.array(stockUpdateSchema).min(1, 'Nothing to update').max(200),
});
export type StockBulkInput = z.infer<typeof stockBulkSchema>;

export interface StockUpdateResult {
  updated: number;
  skipped: { variantId: string; reason: string }[];
  rows: InventoryRow[];
}
