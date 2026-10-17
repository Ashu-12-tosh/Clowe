import { z } from 'zod';
import { assetRefSchema } from './assets';
import type { SellerDispatchClock } from './dispatchWindow';

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
  RTO_IN_TRANSIT: 'Returning to you (RTO)',
  RTO_DELIVERED: 'Back with you (RTO)',
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
  // Undelivered parcels coming back (RTO) are shown with returns.
  RETURNED: ['RETURNED', 'RTO_IN_TRANSIT', 'RTO_DELIVERED'],
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
  /** Human variant label, e.g. "Black · L"; "" for single-SKU. */
  label: string;
  quantity: number;
  pricePaise: number;
  status: string;
  awbNumber: string | null;
  courierName: string | null;
  trackingUrl: string | null;
  /** The parcel this line is booked in with the courier; null until booked. */
  shipmentId: string | null;
  packedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  returnId: string | null;
  returnStatus: string | null;
  /** When Delhivery is due to collect this line's parcel (asked, not collected yet). */
  pickupScheduledFor: string | null;
  /** Delhivery did not collect it last time: ask for a pickup again. */
  pickupFailedAt: string | null;
  /** True when this line can move to the next stage right now. */
  /** Can be booked with Delhivery (gets its AWB): not shipped and not booked yet. */
  canAssign: boolean;
  canPack: boolean;
  canShip: boolean;
  canDeliver: boolean;
}

/** Delivery address as sellers see it - name + address only, never the phone. */
export interface SellerShipTo {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
}

export interface SellerOrderRow {
  orderId: string;
  orderNumber: string;
  placedAt: string;
  /** Buyer name only - contact details are never shared with sellers. */
  customer: { name: string };
  shipTo: SellerShipTo;
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
  /** The seller's packing clip for this order; required before dispatch. */
  packingVideo: PackingVideoView | null;
  /** The dispatch promise and penalty clocks while anything is left to dispatch. */
  dispatch: SellerDispatchClock | null;
  /** This order's parcels with Delhivery, for the seller's actions on them. */
  parcels: SellerParcelView[];
  /** How many of this buyer's parcels came back undelivered before (shown, never blocking). */
  buyerRtoCount: number;
}

/** A parcel as the seller acts on it: failed attempts (NDR) and parcels back with them (RTO). */
export interface SellerParcelView {
  id: string;
  awbNumber: string | null;
  status: string;
  /** Delhivery's latest words on it, e.g. why an attempt failed. */
  statusText: string | null;
  itemIds: string[];
  ndrAction: string | null;
  ndrActionAt: string | null;
  rtoReceivedCondition: string | null;
  /** Failed delivery attempts so far, of MAX_DELIVERY_ATTEMPTS. */
  deliveryAttempts: number;
  /** The delivery address on the order, for correcting it (same PIN code) after a failed attempt. */
  deliverTo: { line1: string; line2: string | null; city: string; pincode: string };
}

/** What can be asked of Delhivery after a failed delivery attempt (NDR). */
export const NDR_ACTIONS = ['RE_ATTEMPT', 'DEFER_DELIVERY', 'EDIT_DETAILS', 'RETURN_TO_SELLER'] as const;

/**
 * POST …/parcels/:id/ndr (seller) and …/shipments/:id/ndr (admin) — after a
 * failed delivery attempt: try again, deliver on a later day, correct the
 * address (the PIN code stays: Delhivery only re-routes within it) or the
 * phone (admins only — sellers never see the buyer's number), or send it back
 * to the seller.
 */
export const parcelNdrSchema = z
  .object({
    action: z.enum(NDR_ACTIONS),
    /** DEFER_DELIVERY: the day to deliver, YYYY-MM-DD, within six days. */
    deferTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** EDIT_DETAILS: the corrected address, within the same PIN code. */
    line1: z.string().trim().min(5, 'Give the full address (house, street)').max(120).optional(),
    line2: z.string().trim().max(120).optional().or(z.literal('')),
    /** EDIT_DETAILS, admins only: the buyer's corrected phone. */
    phone: z
      .string()
      .trim()
      .regex(/^[6-9]\d{9}$/, 'A 10-digit Indian mobile number')
      .optional()
      .or(z.literal('')),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'EDIT_DETAILS' && !v.line1 && !v.phone) {
      ctx.addIssue({ code: 'custom', path: ['line1'], message: 'Give the corrected address or phone' });
    }
  });
export type ParcelNdrInput = z.infer<typeof parcelNdrSchema>;

/** POST /api/seller/orders/parcels/:id/rto-received — the parcel is back; how it came back. */
export const parcelRtoReceivedSchema = z.object({ condition: z.enum(['GOOD', 'DAMAGED']) });

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
  /** Parcels booked, by Delhivery service: Surface or Express. */
  shippingModes: { mode: string; label: string; count: number; share: number }[];
  recentRefunds: {
    returnId: string;
    orderItemId: string;
    orderNumber: string;
    title: string;
    amountPaise: number;
    status: string;
    requestedAt: string;
  }[];
}

export const sellerOrderActionSchema = z.object({
  /**
   * assign: book the parcel with Delhivery (the AWB, for the label) without
   * shipping. ship: hand it over — in the parcel already booked, or booking
   * one now. Delhivery is the only courier, so there is nothing to choose.
   */
  action: z.enum(['assign', 'pack', 'ship', 'deliver']),
});
export type SellerOrderActionInput = z.infer<typeof sellerOrderActionSchema>;

/** POST /api/seller/orders/:orderId/cancel — the seller can't fulfil their part. */
/**
 * Why a seller or Clowe may cancel an order, in whole or in part
 * (Cancellation Policy 3.1). The buyer is told the reason (3.2).
 */
export const ORDER_CANCEL_REASONS = [
  'Out of stock or discontinued',
  'Price, description or image shown in error',
  'Delivery address outside the serviceable area, incomplete or unreachable',
  'Suspected fraud, or the payment was declined or flagged',
  'Placed for resale, or above the quantity limit',
  'Required by a court or a statutory authority',
  'Prevented by a force majeure event',
] as const;

export const sellerOrderCancelSchema = z.object({
  reason: z.string().trim().min(5, 'Say why, in a few words').max(300),
  /** Only these lines (a partial cancellation); all of the seller's when absent. */
  itemIds: z.array(z.string().min(1)).min(1).max(100).optional(),
});
export type SellerOrderCancelInput = z.infer<typeof sellerOrderCancelSchema>;

/** What a seller's cancellation did. */
export interface SellerOrderCancelResult {
  cancelledLines: number;
  /** The refund to the buyer, when they had paid; null for unpaid / COD. */
  refund: { id: string; status: string; amountPaise: number } | null;
  /** The penalty charged, in paise; 0 when none applied. */
  penaltyPaise: number;
}

/** A parcel's box as the seller confirms it at booking: grams and millimetres. */
export const parcelBoxSchema = z.object({
  weightGrams: z.number().int().min(10, 'A parcel weighs at least 10 g').max(100_000, 'Up to 100 kg per parcel'),
  lengthMm: z.number().int().min(10, 'Each side is at least 1 cm').max(3_000, 'Each side is at most 300 cm'),
  widthMm: z.number().int().min(10, 'Each side is at least 1 cm').max(3_000, 'Each side is at most 300 cm'),
  heightMm: z.number().int().min(10, 'Each side is at least 1 cm').max(3_000, 'Each side is at most 300 cm'),
});
export type ParcelBox = z.infer<typeof parcelBoxSchema>;

export const sellerOrderBulkSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1, 'Select at least one item').max(200),
  /** assign books one parcel per order for the selected lines of that order. */
  action: z.enum(['assign', 'pack', 'ship', 'deliver']),
  /** assign: each order's box as the seller confirmed it, keyed by order id. */
  boxes: z.record(z.string(), parcelBoxSchema).optional(),
});

/** POST /api/seller/orders/booking-quote — the estimate, for the products' boxes or the seller's. */
export const sellerBookingQuoteSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1, 'Select at least one item').max(200),
  boxes: z.record(z.string(), parcelBoxSchema).optional(),
});
export type SellerOrderBulkInput = z.infer<typeof sellerOrderBulkSchema>;

export interface SellerOrderBulkResult {
  updated: number;
  /** Lines that couldn't move, with the reason (wrong stage, not yours…). */
  skipped: { itemId: string; reason: string }[];
}

/** GET /api/seller/orders/booking-quote — what booking these lines will cost, before confirming. */
export interface SellerBookingQuote {
  parcels: {
    orderId: string;
    orderNumber: string;
    /** The lines that go in this parcel (one per order). */
    itemIds: string[];
    payment: 'PREPAID' | 'COD';
    codAmountPaise: number;
    /** The box priced: the seller's, or what the products suggest (sides null when unknown). */
    weightGrams: number;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    /** What Delhivery charges for: the greater of actual and volumetric weight. */
    chargeableGrams: number;
    /** Delhivery's forward freight estimate, GST included; null when it could not be priced. */
    forwardFreightPaise: number | null;
    /** COD parcels: Delhivery's COD charge (₹40 or 2 % of the amount, plus GST); 0 for prepaid. */
    codFeePaise: number | null;
    /** Everything this parcel is estimated to cost the seller. */
    totalPaise: number | null;
    error: string | null;
  }[];
  /** Lines that can't be booked now, and why. */
  skipped: { itemId: string; reason: string }[];
  totalPaise: number;
  /** 'mock' while the test courier is in use: its estimate is a flat test rate. */
  provider: string;
}

/** QR printed on labels and invoices - scanning opens the order in the seller panel. */
export interface SellerQr {
  /** What the code encodes: the seller-panel URL for this order, unique per document. */
  url: string;
  /** PNG data URL, ready for an <img>. */
  dataUrl: string;
}

/** Data behind one printable shipping label: one per parcel, or per line until it is booked. */
export interface SellerShippingLabel {
  /** The parcel's id, or the line's while it is not booked. */
  key: string;
  orderItemIds: string[];
  orderNumber: string;
  placedAt: string;
  awbNumber: string | null;
  courierName: string | null;
  /** The courier's sort / routing code for its hubs, when it gives one. */
  sortCode: string | null;
  /** The courier's destination hub, from its packing slip. */
  destinationHub: string | null;
  /** SURFACE or EXPRESS once booked. */
  mode: string | null;
  weightGrams: number | null;
  isCod: boolean;
  /** Amount to collect on delivery (0 for prepaid). */
  codAmountPaise: number;
  contents: { title: string; variantLabel: string; quantity: number; status: string }[];
  shipTo: SellerShipTo;
  shipFrom: {
    shopName: string;
    line1: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    gstNumber: string | null;
  };
  /** Where undelivered parcels come back to, when not the ship-from address above. */
  returnTo: { line1: string; city: string; state: string; pincode: string } | null;
  qr: SellerQr;
}

/** Tax invoice for the seller's lines of one order. */
export interface SellerInvoice {
  invoiceNumber: string;
  issuedAt: string;
  orderNumber: string;
  placedAt: string;
  paymentMethod: string;
  paymentStatus: string;
  /** The supplier: the tax invoice is the seller's, issued under their GSTIN. */
  seller: {
    shopName: string;
    /** The registered name: the name on the seller's PAN, else the shop name. */
    legalName: string;
    line1: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    gstNumber: string | null;
    panNumber: string | null;
  };
  /** The e-commerce operator the sale went through (Clowe Partners LLP), from settings. */
  marketplace: { name: string; gstin: string | null; address: string | null };
  billTo: SellerShipTo;
  /** The buyer's GSTIN, when they gave one at checkout (a business purchase). */
  buyerGstin: string | null;
  /** Buyer name only - no contact details reach sellers. */
  customer: { name: string };
  lines: {
    title: string;
    size: string;
    color: string;
    variantLabel: string;
    quantity: number;
    /** Price the customer paid per unit (tax inclusive). */
    unitPricePaise: number;
    grossPaise: number;
    taxablePaise: number;
    gstPaise: number;
    /** This line's rate — lines of one order can sit in different slabs. */
    gstRatePercent: number;
    /** HSN of the line's category, when one is set. */
    hsnCode: string | null;
    /** The line's GST, split: CGST + SGST for a same-state supply, else IGST. */
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
  }[];
  /** GST rate of the first line, e.g. 5 or 18; each line carries its own. */
  gstRatePercent: number;
  taxablePaise: number;
  gstPaise: number;
  /** Same-state supply splits GST into CGST + SGST, otherwise IGST. */
  isIntraState: boolean;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  qr: SellerQr;
}
/** A tax invoice without the seller's QR code: the buyer's copy, and what the service builds.
 */
export type TaxInvoice = Omit<SellerInvoice, 'qr'>;


// ---------------------------------------------------------------------------
// Packing video, per order
//
// A seller records what went into the box, once per order, before it ships:
// the proof both sides can look at if a return is disputed. Private to that
// seller and admins — the buyer never sees it — and kept until 45 days after
// delivery and for as long as a return on the order is open.
// ---------------------------------------------------------------------------

export const PACKING_VIDEO_RETENTION_DAYS = 45;
/** A packing clip is recorded in the page and stops itself at this length. */
export const PACKING_VIDEO_MAX_SECONDS = 60;
/** …or at this size, whichever comes first (the upload limit is 50 MB). */
export const PACKING_VIDEO_MAX_BYTES = 40 * 1024 * 1024;

export interface PackingVideoView {
  /** Signed, short-lived link to play it; null in lists, and once the file is gone. */
  url: string | null;
  uploadedAt: string;
  /** Retention ended and the file was deleted; the record stays. */
  deleted: boolean;
}

export const packingVideoAttachSchema = z.object({ ref: assetRefSchema });
export type PackingVideoAttachInput = z.infer<typeof packingVideoAttachSchema>;

/** Why "Mark shipped" is refused, in the seller's terms. */
/** Why a seller can't mark a Delhivery parcel delivered: only its delivery scan does. */
export const COURIER_DELIVERS_MESSAGE =
  "Delhivery marks this parcel delivered when it scans the delivery — it can't be marked delivered by hand.";

export const PACKING_VIDEO_REQUIRED_MESSAGE =
  'Record the packing video for this order before you pack or ship it: it shows what went into the box if a return is disputed.';
