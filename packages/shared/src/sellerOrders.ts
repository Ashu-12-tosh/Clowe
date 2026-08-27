import { z } from 'zod';

// ---------------------------------------------------------------------------
// Seller Order Management
//
// A seller only ever sees their own lines of an order, so every amount here is
// the seller's share — never the customer's order total.
// ---------------------------------------------------------------------------

/** Fulfilment stages a seller drives, in order. */
export const SELLER_FULFILMENT_FLOW = ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED'] as const;

export const ORDER_STATUS_LABELS: Record<string, string> = {
  PLACED: 'Payment pending',
  CONFIRMED: 'New order',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURN_REQUESTED: 'Return requested',
  RETURNED: 'Returned',
};

/** Tiles across the top of the page; each one filters the table. */
export const SELLER_ORDER_TABS = [
  'ALL',
  'NEW',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
  'REFUNDS',
] as const;
export type SellerOrderTab = (typeof SELLER_ORDER_TABS)[number];

export const SELLER_ORDER_TAB_LABELS: Record<SellerOrderTab, string> = {
  ALL: 'All orders',
  NEW: 'New orders',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURNED: 'Returned',
  REFUNDS: 'Refund requests',
};

/** Order statuses each tile covers (item-level). */
export const SELLER_ORDER_TAB_STATUSES: Record<SellerOrderTab, string[] | null> = {
  ALL: null,
  NEW: ['CONFIRMED'],
  PACKED: ['PACKED'],
  SHIPPED: ['SHIPPED'],
  DELIVERED: ['DELIVERED'],
  CANCELLED: ['CANCELLED'],
  RETURNED: ['RETURNED'],
  REFUNDS: ['RETURN_REQUESTED'],
};

export const SELLER_ORDER_SORTS = ['NEWEST', 'OLDEST', 'AMOUNT_HIGH', 'AMOUNT_LOW'] as const;
export type SellerOrderSort = (typeof SELLER_ORDER_SORTS)[number];

export const SELLER_ORDER_SORT_LABELS: Record<SellerOrderSort, string> = {
  NEWEST: 'Newest first',
  OLDEST: 'Oldest first',
  AMOUNT_HIGH: 'Amount: high to low',
  AMOUNT_LOW: 'Amount: low to high',
};

export const SELLER_PAYMENT_FILTERS = ['ALL', 'PAID', 'COD', 'REFUNDED', 'PENDING'] as const;
export type SellerPaymentFilter = (typeof SELLER_PAYMENT_FILTERS)[number];

export interface SellerOrderLine {
  id: string; // order item id
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  size: string;
  color: string;
  quantity: number;
  pricePaise: number;
  status: string;
  awbNumber: string | null;
  courierName: string | null;
  trackingUrl: string | null;
  packedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  returnId: string | null;
  returnStatus: string | null;
  /** True when this line can move to the next stage right now. */
  canPack: boolean;
  canShip: boolean;
  canDeliver: boolean;
}

export interface SellerOrderRow {
  orderId: string;
  orderNumber: string;
  placedAt: string;
  customer: { name: string; email: string | null; phone: string };
  shipTo: {
    name: string;
    phone: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    pincode: string;
  };
  lines: SellerOrderLine[];
  itemCount: number;
  unitCount: number;
  /** Seller's share of this order (price × qty over their lines). */
  amountPaise: number;
  paymentMethod: string;
  paymentStatus: string;
  isCod: boolean;
  deliveryMethod: string;
  isGift: boolean;
  /** Representative status for the seller's part of the order. */
  status: string;
  /** True when the seller's lines are in more than one stage. */
  mixedStatus: boolean;
}

export interface SellerOrderPage {
  rows: SellerOrderRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SellerOrderTile {
  key: SellerOrderTab;
  label: string;
  count: number;
  valuePaise: number;
}

export interface SellerOrderSummary {
  tiles: SellerOrderTile[];
  overview: {
    totalOrders: number;
    totalSalesPaise: number;
    avgOrderValuePaise: number;
    /** 0–100, share of sold units that came back. */
    returnRate: number;
    cancelRate: number;
  };
  topCouriers: { courier: string; count: number; share: number }[];
  recentRefunds: {
    returnId: string;
    orderItemId: string;
    orderNumber: string;
    title: string;
    amountPaise: number;
    status: string;
    requestedAt: string;
  }[];
  /** Courier options for "Assign courier" (from the shipping provider). */
  couriers: string[];
}

export const sellerOrderActionSchema = z.object({
  action: z.enum(['pack', 'ship', 'deliver']),
  /** Only used by 'ship'. */
  courier: z.string().trim().max(60).optional(),
});
export type SellerOrderActionInput = z.infer<typeof sellerOrderActionSchema>;

export const sellerOrderBulkSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1, 'Select at least one item').max(200),
  action: z.enum(['pack', 'ship', 'deliver']),
  courier: z.string().trim().max(60).optional(),
});
export type SellerOrderBulkInput = z.infer<typeof sellerOrderBulkSchema>;

export interface SellerOrderBulkResult {
  updated: number;
  /** Lines that couldn't move, with the reason (wrong stage, not yours…). */
  skipped: { itemId: string; reason: string }[];
}

/** Data behind one printable shipping label. */
export interface SellerShippingLabel {
  orderItemId: string;
  orderNumber: string;
  placedAt: string;
  awbNumber: string | null;
  courierName: string | null;
  status: string;
  isCod: boolean;
  /** Amount to collect on delivery (0 for prepaid). */
  codAmountPaise: number;
  title: string;
  size: string;
  color: string;
  quantity: number;
  shipTo: SellerOrderRow['shipTo'];
  shipFrom: {
    shopName: string;
    line1: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    gstNumber: string | null;
  };
}

/** Tax invoice for the seller's lines of one order. */
export interface SellerInvoice {
  invoiceNumber: string;
  issuedAt: string;
  orderNumber: string;
  placedAt: string;
  paymentMethod: string;
  paymentStatus: string;
  seller: {
    shopName: string;
    line1: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    gstNumber: string | null;
    panNumber: string | null;
  };
  billTo: SellerOrderRow['shipTo'];
  customer: { name: string; phone: string; email: string | null };
  lines: {
    title: string;
    size: string;
    color: string;
    quantity: number;
    /** Price the customer paid per unit (tax inclusive). */
    unitPricePaise: number;
    grossPaise: number;
    taxablePaise: number;
    gstPaise: number;
  }[];
  /** GST rate applied, e.g. 5 or 12. */
  gstRatePercent: number;
  taxablePaise: number;
  gstPaise: number;
  /** Same-state supply splits GST into CGST + SGST, otherwise IGST. */
  isIntraState: boolean;
  totalPaise: number;
}
