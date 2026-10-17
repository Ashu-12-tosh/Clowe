import { z } from 'zod';

// ---------------------------------------------------------------------------
// Order management (admin)
//
// Everything here reads the real Order/OrderItem/Payment tables. Order status
// is a roll-up of the item statuses (a multi-vendor order is only "shipped"
// once every line has shipped), so the admin acts on lines, not on a made-up
// order-level flag.
// ---------------------------------------------------------------------------

export const ORDER_TABS = [
  'ALL',
  'PENDING',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
] as const;
export type OrderTab = (typeof ORDER_TABS)[number];

export const ORDER_TAB_LABELS: Record<OrderTab, string> = {
  ALL: 'All',
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURNED: 'Returned',
};

/**
 * Which raw order statuses each tab covers. PLACED means the shopper started
 * checkout but the money never landed, so it belongs with Pending.
 */
export const ORDER_TAB_STATUSES: Record<OrderTab, string[]> = {
  ALL: [],
  PENDING: ['PLACED'],
  PROCESSING: ['CONFIRMED', 'PACKED'],
  SHIPPED: ['SHIPPED'],
  DELIVERED: ['DELIVERED'],
  CANCELLED: ['CANCELLED'],
  // RTO (came back undelivered) sits with returns: neither is a sale.
  RETURNED: ['RETURN_REQUESTED', 'RETURNED', 'RTO_IN_TRANSIT', 'RTO_DELIVERED'],
};

export const ADMIN_ORDER_STATUSES = [
  'PLACED',
  'CONFIRMED',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURN_REQUESTED',
  'RETURNED',
  'RTO_IN_TRANSIT',
  'RTO_DELIVERED',
] as const;
export type AdminOrderStatus = (typeof ADMIN_ORDER_STATUSES)[number];

export const ADMIN_ORDER_STATUS_LABELS: Record<AdminOrderStatus, string> = {
  PLACED: 'Awaiting payment',
  CONFIRMED: 'Confirmed',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURN_REQUESTED: 'Return requested',
  RETURNED: 'Returned',
  RTO_IN_TRANSIT: 'Returning to seller (RTO)',
  RTO_DELIVERED: 'Back with seller (RTO)',
};

export const ADMIN_PAYMENT_STATUSES = [
  'PAID',
  'CREATED',
  'FAILED',
  'REFUNDED',
  'COD_PENDING',
] as const;
export type AdminPaymentStatus = (typeof ADMIN_PAYMENT_STATUSES)[number];

export const ADMIN_PAYMENT_STATUS_LABELS: Record<AdminPaymentStatus, string> = {
  PAID: 'Paid',
  CREATED: 'Pending',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
  COD_PENDING: 'COD (on delivery)',
};

/**
 * How the order reached us. Only two are real today: a shopper checking out,
 * or an admin placing it for them. No made-up app/WhatsApp channels.
 */
export const ORDER_CHANNELS = ['WEB', 'ADMIN'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const ORDER_CHANNEL_LABELS: Record<OrderChannel, string> = {
  WEB: 'Storefront',
  ADMIN: 'Placed by admin',
};

export const ADMIN_ORDER_SORTS = [
  'NEWEST',
  'OLDEST',
  'AMOUNT_HIGH',
  'AMOUNT_LOW',
  'STATUS',
] as const;
export type AdminOrderSort = (typeof ADMIN_ORDER_SORTS)[number];

export const ADMIN_ORDER_SORT_LABELS: Record<AdminOrderSort, string> = {
  NEWEST: 'Newest first',
  OLDEST: 'Oldest first',
  AMOUNT_HIGH: 'Amount: high to low',
  AMOUNT_LOW: 'Amount: low to high',
  STATUS: 'Status',
};

// --- Rows -------------------------------------------------------------------

export interface AdminOrderListRow {
  id: string;
  orderNumber: string;
  customer: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string;
    avatarUrl: string | null;
  };
  itemCount: number;
  /** First few product thumbnails, for the stacked preview in the table. */
  itemThumbnails: string[];
  totalPaise: number;
  paymentStatus: AdminPaymentStatus;
  paymentStatusLabel: string;
  paymentMethod: string;
  status: AdminOrderStatus;
  statusLabel: string;
  sellerNames: string[];
  channel: OrderChannel;
  createdAt: string;
}

export interface AdminOrderItemRow {
  id: string;
  productId: string;
  variantId: string;
  title: string;
  imageUrl: string | null;
  size: string;
  color: string;
  variantLabel: string;
  sku: string;
  sellerId: string;
  sellerName: string;
  quantity: number;
  pricePaise: number;
  status: AdminOrderStatus;
  statusLabel: string;
  trackingNumber: string | null;
  courier: string | null;
  /** Set once a return has been raised against this line. */
  returnStatus: string | null;
}

export interface AdminOrderDetail {
  id: string;
  orderNumber: string;
  status: AdminOrderStatus;
  statusLabel: string;
  channel: OrderChannel;
  createdAt: string;
  updatedAt: string;
  placedByAdminName: string | null;
  adminNote: string | null;

  customer: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string;
    avatarUrl: string | null;
    /** Everything this shopper has ever ordered. */
    orderCount: number;
    lifetimeValuePaise: number;
    /** Parcels of theirs that came back undelivered (RTO). Shown, never blocking. */
    rtoCount: number;
  };

  shipping: {
    name: string;
    phone: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    pincode: string;
    method: string;
    etaFrom: string | null;
    etaTo: string | null;
  };

  summary: {
    itemsTotalPaise: number;
    shippingPaise: number;
    discountPaise: number;
    couponCode: string | null;
    couponDiscountPaise: number;
    creditsUsed: number;
    /** GST already inside the item prices, shown for the invoice line. */
    taxPaise: number;
    totalPaise: number;
  };

  payment: {
    method: string;
    status: AdminPaymentStatus;
    statusLabel: string;
    provider: string | null;
    providerOrderId: string | null;
    providerPaymentId: string | null;
    paidAt: string | null;
    failureReason: string | null;
    refundedPaise: number;
  };

  items: AdminOrderItemRow[];
  isGift: boolean;
  giftMessage: string | null;
  /** Support tickets the shopper raised about this order. */
  complaints: { id: string; reference: string; subject: string; status: string }[];
}

export interface AdminOrdersPage {
  rows: AdminOrderListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Row counts per tab under the current filters, for the tab badges. */
  tabCounts: Record<OrderTab, number>;
}

export interface AdminOrdersSummary {
  kpis: {
    total: { value: number; changePercent: number | null };
    pending: number;
    processing: number;
    shipped: number;
    delivered: number;
    returned: number;
    cancelled: number;
    revenuePaise: number;
    averageOrderValuePaise: number;
    averageOrderValueChangePercent: number | null;
  };
  /** Orders per day over the selected range. */
  trend: { date: string; orders: number; revenuePaise: number }[];
  statusDistribution: { key: string; label: string; count: number; share: number }[];
  paymentDistribution: { key: string; label: string; count: number; share: number }[];
  topSellers: { id: string; name: string; orders: number; revenuePaise: number }[];
}

export interface AdminOrderCustomerHit {
  id: string;
  name: string | null;
  email: string | null;
  phone: string;
  addresses: {
    id: string;
    label: string;
    name: string;
    phone: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    pincode: string;
  }[];
}

// --- Inputs -----------------------------------------------------------------

/** Move one line (or every line) of an order to a new status. */
export const adminOrderStatusSchema = z.object({
  status: z.enum(['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']),
  /** Omit to apply to every live line on the order. */
  itemId: z.string().min(1).optional(),
  /** The Delhivery AWB, when the parcel was booked outside Clowe. */
  trackingNumber: z.string().trim().max(60).optional().or(z.literal('')),
  note: z.string().trim().max(300).optional().or(z.literal('')),
  /**
   * Packing or shipping a line whose seller has not recorded the packing
   * video is allowed from the desk only with this, and it goes on the audit log.
   */
  noClipReason: z.string().trim().min(5, 'Give a reason (min 5 chars)').max(300).optional(),
  /**
   * Marking a Delhivery parcel delivered by hand (its delivery scan normally
   * does) needs this, and it goes on the audit log.
   */
  deliveryOverrideReason: z.string().trim().min(5, 'Give a reason (min 5 chars)').max(300).optional(),
});
export type AdminOrderStatusInput = z.infer<typeof adminOrderStatusSchema>;

/**
 * Why an admin cancels: a fixed list, each with the words the customer sees.
 * "Other" carries a short text the admin writes and confirms.
 */
export const ADMIN_CANCEL_REASONS = ['OUT_OF_STOCK', 'SELLER_UNABLE', 'ADDRESS_NOT_SERVICEABLE', 'SUSPECTED_FRAUD', 'CUSTOMER_REQUEST', 'OTHER'] as const;
export type AdminCancelReason = (typeof ADMIN_CANCEL_REASONS)[number];

export const ADMIN_CANCEL_REASON_LABELS: Record<AdminCancelReason, string> = {
  OUT_OF_STOCK: 'Out of stock',
  SELLER_UNABLE: 'Seller unable to fulfil',
  ADDRESS_NOT_SERVICEABLE: 'Address not serviceable',
  SUSPECTED_FRAUD: 'Suspected fraud',
  CUSTOMER_REQUEST: 'Customer request',
  OTHER: 'Other',
};

/** What the customer is told, in their notification and on the order. */
export const ADMIN_CANCEL_CUSTOMER_TEXT: Record<Exclude<AdminCancelReason, 'OTHER'>, string> = {
  OUT_OF_STOCK: 'The item is out of stock, so we have cancelled it.',
  SELLER_UNABLE: 'The seller is unable to fulfil this order, so we have cancelled it.',
  ADDRESS_NOT_SERVICEABLE: 'Our courier does not deliver to this address yet, so we have cancelled the order.',
  SUSPECTED_FRAUD: 'We could not verify this order, so we have cancelled it.',
  CUSTOMER_REQUEST: 'Cancelled at your request.',
};

const cancelReasonFields = {
  reasonCode: z.enum(ADMIN_CANCEL_REASONS).optional(),
  /** For "Other": the words the customer sees. */
  otherText: z.string().trim().max(200).optional(),
  /** Free text, from before the list (still accepted from scripts and tests). */
  reason: z.string().trim().min(3).max(300).optional(),
};
type CancelReasonInput = { reasonCode?: AdminCancelReason; otherText?: string; reason?: string };
const reasonGiven = (v: CancelReasonInput, ctx: z.RefinementCtx) => {
  if (v.reasonCode === 'OTHER' && (v.otherText ?? '').length < 5) {
    ctx.addIssue({ code: 'custom', path: ['otherText'], message: 'Write what the customer should be told (at least 5 characters)' });
  }
  if (!v.reasonCode && !v.reason) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'Pick why this is being cancelled' });
};

/** The words the customer sees for a cancellation. */
export function adminCancelReasonText(v: CancelReasonInput): string {
  if (v.reasonCode === 'OTHER') return (v.otherText ?? '').trim();
  if (v.reasonCode) return ADMIN_CANCEL_CUSTOMER_TEXT[v.reasonCode];
  return (v.reason ?? '').trim();
}

export const adminOrderCancelSchema = z.object(cancelReasonFields).superRefine(reasonGiven);

/** Cancel some lines of an order, with the reason the buyer is told. */
export const adminOrderLinesCancelSchema = z
  .object({ ...cancelReasonFields, itemIds: z.array(z.string().min(1)).min(1).max(100) })
  .superRefine(reasonGiven);
export type AdminOrderCancelInput = z.infer<typeof adminOrderCancelSchema>;

export const adminOrderNoteSchema = z.object({
  adminNote: z.string().trim().max(500),
});
export type AdminOrderNoteInput = z.infer<typeof adminOrderNoteSchema>;

export const MANUAL_PAYMENT_METHODS = ['COD', 'UPI', 'CARD', 'NETBANKING'] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

export const MANUAL_PAYMENT_METHOD_LABELS: Record<ManualPaymentMethod, string> = {
  COD: 'Cash on delivery',
  UPI: 'UPI (already collected)',
  CARD: 'Card (already collected)',
  NETBANKING: 'Net banking (already collected)',
};

/**
 * An order an admin places for a shopper — a phone order. It runs the same
 * stock reservation and seller notification as a storefront checkout, so it is
 * a real order in every downstream report.
 */
export const manualOrderSchema = z.object({
  userId: z.string().min(1, 'Pick a customer'),
  addressId: z.string().min(1, 'Pick a delivery address'),
  paymentMethod: z.enum(MANUAL_PAYMENT_METHODS),
  /** Standard only, and free: buyers never pay for delivery. */
  deliveryMethod: z.enum(['STANDARD']).default('STANDARD'),
  adminNote: z.string().trim().max(500).optional().or(z.literal('')),
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1).max(50),
      }),
    )
    .min(1, 'Add at least one item'),
});
export type ManualOrderInput = z.infer<typeof manualOrderSchema>;

/** Column order of the bulk phone-order CSV. */
export const ORDER_IMPORT_COLUMNS = [
  'Customer phone',
  'SKU',
  'Quantity',
  'Payment method',
  'Note',
] as const;

export const manualOrderImportSchema = z.object({
  rows: z
    .array(
      z.object({
        phone: z.string().trim().min(10),
        sku: z.string().trim().min(1),
        quantity: z.number().int().min(1).max(50),
        paymentMethod: z.enum(MANUAL_PAYMENT_METHODS).default('COD'),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .min(1, 'The file has no rows')
    .max(500, 'Split files larger than 500 rows'),
});
export type ManualOrderImportInput = z.infer<typeof manualOrderImportSchema>;

export interface ManualOrderImportResult {
  created: { orderNumber: string; phone: string; totalPaise: number }[];
  skipped: { row: number; phone: string; reason: string }[];
}
