import { z } from 'zod';

// ---------------------------------------------------------------------------
// Inventory & warehouse management (admin)
//
// Stock lives on the variant (`ProductVariant.stock`) and is split across
// warehouses by StockLocation. Every figure here comes from those two tables
// plus the StockMovement ledger — nothing is estimated.
// ---------------------------------------------------------------------------

export const INVENTORY_TABS = [
  'OVERVIEW',
  'WAREHOUSES',
  'MOVEMENTS',
  'ADJUSTMENTS',
  'SUPPLIERS',
  'PURCHASE_ORDERS',
] as const;
export type InventoryTab = (typeof INVENTORY_TABS)[number];

export const INVENTORY_TAB_LABELS: Record<InventoryTab, string> = {
  OVERVIEW: 'Inventory Overview',
  WAREHOUSES: 'Warehouse Management',
  MOVEMENTS: 'Stock Movements',
  ADJUSTMENTS: 'Stock Adjustments',
  SUPPLIERS: 'Suppliers',
  PURCHASE_ORDERS: 'Purchase Orders',
};

export const STOCK_STATUSES = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'OVERSTOCK'] as const;
export type StockStatusValue = (typeof STOCK_STATUSES)[number];

export const STOCK_STATUS_LABELS: Record<StockStatusValue, string> = {
  IN_STOCK: 'In Stock',
  LOW_STOCK: 'Low Stock',
  OUT_OF_STOCK: 'Out of Stock',
  OVERSTOCK: 'Overstock',
};

/**
 * A location holding more than this multiple of its reorder level is capital
 * sitting still — flagged as overstock so it can be transferred or discounted.
 */
export const OVERSTOCK_MULTIPLE = 10;

export const MOVEMENT_TYPES = ['RECEIPT', 'DISPATCH', 'TRANSFER', 'ADJUSTMENT', 'RETURN'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  RECEIPT: 'Receipt',
  DISPATCH: 'Dispatch',
  TRANSFER: 'Transfer',
  ADJUSTMENT: 'Adjustment',
  RETURN: 'Return',
};

export const PO_STATUSES = ['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  DRAFT: 'Draft',
  ORDERED: 'Ordered',
  PARTIAL: 'Partially received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
};

export const TRANSFER_STATUSES = ['PENDING', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  PENDING: 'Pending',
  IN_TRANSIT: 'In transit',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const INVENTORY_SORT_OPTIONS = [
  'STOCK_LOW',
  'STOCK_HIGH',
  'VALUE_HIGH',
  'UPDATED',
  'SKU',
] as const;
export type InventorySortOption = (typeof INVENTORY_SORT_OPTIONS)[number];

export const INVENTORY_SORT_OPTION_LABELS: Record<InventorySortOption, string> = {
  STOCK_LOW: 'Stock: low to high',
  STOCK_HIGH: 'Stock: high to low',
  VALUE_HIGH: 'Stock value: high to low',
  UPDATED: 'Recently updated',
  SKU: 'SKU (A–Z)',
};

// --- Rows -------------------------------------------------------------------

export interface InventoryStockRow {
  locationId: string;
  variantId: string;
  productId: string;
  sku: string;
  title: string;
  imageUrl: string | null;
  categoryName: string;
  brandName: string | null;
  sellerName: string;
  size: string;
  color: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  /** On the shelf right now. */
  available: number;
  /** Paid for but not yet handed to a courier — spoken for, not sellable. */
  reserved: number;
  /** On an open purchase order or an in-flight transfer. */
  incoming: number;
  reorderLevel: number;
  status: StockStatusValue;
  statusLabel: string;
  unitPricePaise: number;
  stockValuePaise: number;
  lastMovementAt: string | null;
  updatedAt: string;
}

export interface InventoryStockPage {
  rows: InventoryStockRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface InventoryKpis {
  totalSkus: number;
  totalUnits: number;
  inventoryValuePaise: number;
  lowStockItems: number;
  outOfStockItems: number;
  overstockItems: number;
  /**
   * Share of counted locations where the shelf matched the system. Null until
   * at least one cycle count has been done — an uncounted warehouse has no
   * accuracy, and showing 100% would be a lie.
   */
  stockAccuracyPercent: number | null;
  countedLocations: number;
}

export interface InventoryStrip {
  activeWarehouses: number;
  unitsInTransit: number;
  receiptsToday: number;
  dispatchToday: number;
  pendingTransfers: number;
}

export interface WarehouseValueSlice {
  id: string;
  code: string;
  name: string;
  valuePaise: number;
  units: number;
  share: number;
}

export interface LowStockAlert {
  locationId: string;
  variantId: string;
  sku: string;
  title: string;
  warehouseName: string;
  available: number;
  reorderLevel: number;
}

export interface StockAccuracyPanel {
  matched: number;
  mismatched: number;
  notCounted: number;
  accuracyPercent: number | null;
}

export interface MovementRow {
  id: string;
  type: MovementType;
  typeLabel: string;
  sku: string;
  title: string;
  variantId: string;
  quantity: number;
  fromWarehouse: string | null;
  toWarehouse: string | null;
  reason: string | null;
  reference: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface MovementPage {
  rows: MovementRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminInventorySummary {
  kpis: InventoryKpis;
  strip: InventoryStrip;
  valueByWarehouse: WarehouseValueSlice[];
  statusBreakdown: { key: StockStatusValue; label: string; count: number; share: number }[];
  lowStockAlerts: LowStockAlert[];
  accuracy: StockAccuracyPanel;
  recentMovements: MovementRow[];
  /** Units received / dispatched / transferred / adjusted this month. */
  movementTotals: { receipts: number; dispatch: number; transfers: number; adjustments: number };
  /** Daily inventory value across the last 30 days, derived from the ledger. */
  valueTrend: { date: string; valuePaise: number }[];
  topCategories: { id: string; name: string; valuePaise: number; units: number; share: number }[];
  insights: {
    key: string;
    tone: 'INFO' | 'GOOD' | 'WARN' | 'BAD';
    title: string;
    detail: string;
  }[];
}

export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  city: string;
  state: string;
  pincode: string | null;
  addressLine: string | null;
  contactName: string | null;
  contactPhone: string | null;
  isActive: boolean;
  isDefault: boolean;
  skus: number;
  units: number;
  valuePaise: number;
  lowStockCount: number;
  createdAt: string;
}

export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  gstin: string | null;
  notes: string | null;
  isActive: boolean;
  purchaseOrders: number;
  unitsSupplied: number;
  spendPaise: number;
  lastOrderAt: string | null;
  createdAt: string;
}

export interface PurchaseOrderItemRow {
  id: string;
  variantId: string;
  sku: string;
  title: string;
  size: string;
  color: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitCostPaise: number;
}

export interface PurchaseOrderRow {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  warehouseId: string;
  warehouseName: string;
  status: PoStatus;
  statusLabel: string;
  expectedAt: string | null;
  receivedAt: string | null;
  notes: string | null;
  createdByName: string | null;
  totalUnits: number;
  receivedUnits: number;
  totalCostPaise: number;
  createdAt: string;
  items: PurchaseOrderItemRow[];
}

export interface TransferRow {
  id: string;
  transferNumber: string;
  fromWarehouse: string;
  toWarehouse: string;
  status: TransferStatus;
  statusLabel: string;
  totalUnits: number;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  items: { variantId: string; sku: string; title: string; quantity: number }[];
}

/** Everything a filter dropdown needs, in one call. */
export interface InventoryFilterOptions {
  warehouses: { id: string; code: string; name: string; isActive: boolean }[];
  categories: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  sellers: { id: string; name: string }[];
  suppliers: { id: string; code: string; name: string }[];
}

// --- Inputs -----------------------------------------------------------------

export const warehouseSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Code is too short')
    .max(16)
    .regex(/^[A-Z0-9-]+$/, 'Use capitals, digits and dashes only'),
  name: z.string().trim().min(2, 'Name is too short').max(80),
  city: z.string().trim().min(2).max(60),
  state: z.string().trim().min(2).max(60),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Pincode must be 6 digits')
    .optional()
    .or(z.literal('')),
  addressLine: z.string().trim().max(200).optional().or(z.literal('')),
  contactName: z.string().trim().max(80).optional().or(z.literal('')),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Phone must be 10 digits')
    .optional()
    .or(z.literal('')),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
export type WarehouseInput = z.infer<typeof warehouseSchema>;

export const supplierSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(16)
    .regex(/^[A-Z0-9-]+$/, 'Use capitals, digits and dashes only'),
  name: z.string().trim().min(2, 'Name is too short').max(120),
  contactName: z.string().trim().max(80).optional().or(z.literal('')),
  email: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  phone: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Phone must be 10 digits')
    .optional()
    .or(z.literal('')),
  city: z.string().trim().max(60).optional().or(z.literal('')),
  state: z.string().trim().max(60).optional().or(z.literal('')),
  gstin: z.string().trim().max(20).optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

export const stockAdjustmentSchema = z.object({
  locationId: z.string().min(1),
  /** The count a human actually found on the shelf. */
  newQuantity: z.number().int().min(0).max(1_000_000),
  reason: z.string().trim().min(3, 'Say why the count changed').max(200),
  /** True when this came from a cycle count, so it feeds stock accuracy. */
  isCount: z.boolean().default(false),
});
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

export const reorderLevelSchema = z.object({
  locationId: z.string().min(1),
  reorderLevel: z.number().int().min(0).max(100_000),
});
export type ReorderLevelInput = z.infer<typeof reorderLevelSchema>;

/** Stock arriving without a purchase order — a direct receipt. */
export const directReceiptSchema = z.object({
  warehouseId: z.string().min(1, 'Pick a warehouse'),
  reason: z.string().trim().min(3, 'Say where this stock came from').max(200),
  reference: z.string().trim().max(60).optional().or(z.literal('')),
  lines: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1).max(100_000),
      }),
    )
    .min(1, 'Add at least one line'),
});
export type DirectReceiptInput = z.infer<typeof directReceiptSchema>;

export const IMPORT_MODES = ['SET', 'ADD'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export const IMPORT_MODE_LABELS: Record<ImportMode, string> = {
  SET: 'Set to this quantity',
  ADD: 'Add this quantity',
};

/** Column order of the import/template CSV. Kept next to the parser it feeds. */
export const IMPORT_COLUMNS = ['SKU', 'Warehouse code', 'Quantity', 'Reorder level'] as const;

export const inventoryImportSchema = z.object({
  mode: z.enum(IMPORT_MODES).default('SET'),
  reason: z.string().trim().min(3, 'Say why stock is being imported').max(200),
  /** True when the sheet is a physical count, so it feeds stock accuracy. */
  isCount: z.boolean().default(false),
  rows: z
    .array(
      z.object({
        sku: z.string().trim().min(1),
        warehouseCode: z.string().trim().min(1),
        /** Omit to leave the quantity alone and only set the reorder level. */
        quantity: z.number().int().min(0).max(1_000_000).optional(),
        reorderLevel: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .min(1, 'The file has no rows')
    .max(2000, 'Split files larger than 2,000 rows'),
});
export type InventoryImportInput = z.infer<typeof inventoryImportSchema>;

export interface InventoryImportResult {
  applied: number;
  quantityChanged: number;
  reorderChanged: number;
  skipped: { row: number; sku: string; reason: string }[];
}

export const purchaseOrderSchema = z.object({
  supplierId: z.string().min(1, 'Pick a supplier'),
  warehouseId: z.string().min(1, 'Pick a destination warehouse'),
  expectedAt: z.string().datetime().optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantityOrdered: z.number().int().min(1).max(100_000),
        unitCostPaise: z.number().int().min(0).max(100_000_000).default(0),
      }),
    )
    .min(1, 'Add at least one line'),
});
export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>;

export const receivePurchaseOrderSchema = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        /** Units arriving now, on top of anything already received. */
        quantity: z.number().int().min(0).max(100_000),
      }),
    )
    .min(1, 'Nothing to receive'),
});
export type ReceivePurchaseOrderInput = z.infer<typeof receivePurchaseOrderSchema>;

export const transferSchema = z.object({
  fromWarehouseId: z.string().min(1, 'Pick a source warehouse'),
  toWarehouseId: z.string().min(1, 'Pick a destination warehouse'),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1).max(100_000),
      }),
    )
    .min(1, 'Add at least one line'),
});
export type TransferInput = z.infer<typeof transferSchema>;

export const transferStatusSchema = z.object({
  status: z.enum(['IN_TRANSIT', 'COMPLETED', 'CANCELLED']),
});
export type TransferStatusInput = z.infer<typeof transferStatusSchema>;

/** Bulk actions on the overview table. */
export const inventoryBulkSchema = z.object({
  locationIds: z.array(z.string().min(1)).min(1, 'Select at least one row').max(200),
  action: z.enum(['SET_REORDER', 'MARK_COUNTED', 'ADJUST']),
  reorderLevel: z.number().int().min(0).max(100_000).optional(),
  newQuantity: z.number().int().min(0).max(1_000_000).optional(),
  reason: z.string().trim().max(200).optional(),
});
export type InventoryBulkInput = z.infer<typeof inventoryBulkSchema>;

export interface InventoryBulkResult {
  updated: number;
  skipped: { locationId: string; reason: string }[];
}
