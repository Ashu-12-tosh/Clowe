// ---------------------------------------------------------------------------
// The admin's parcels desk: every parcel with the courier.
// ---------------------------------------------------------------------------

export const ADMIN_SHIPMENT_FILTERS = ['ATTENTION', 'AWAITING_PICKUP', 'IN_TRANSIT', 'DELIVERED', 'RTO', 'CANCELLED', 'ALL'] as const;
export type AdminShipmentFilter = (typeof ADMIN_SHIPMENT_FILTERS)[number];
export const ADMIN_SHIPMENT_FILTER_LABELS: Record<AdminShipmentFilter, string> = {
  ATTENTION: 'Needs attention',
  AWAITING_PICKUP: 'Awaiting pickup',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  RTO: 'Coming back (RTO)',
  CANCELLED: 'Cancelled / lost',
  ALL: 'All',
};

export interface AdminShipmentRow {
  id: string;
  /** FORWARD to the buyer, or REVERSE: a return coming back. */
  kind: string;
  awbNumber: string | null;
  orderId: string;
  orderNumber: string;
  shopName: string;
  status: string;
  statusText: string | null;
  paymentType: string;
  codAmountPaise: number;
  lastScanAt: string | null;
  createdAt: string;
  ndrAction: string | null;
  /** Failed delivery attempts so far, of MAX_DELIVERY_ATTEMPTS. */
  deliveryAttempts: number;
  /** The order's delivery address, for correcting it after a failed attempt. */
  deliverTo: { line1: string; line2: string | null; city: string; pincode: string };
  /** Delhivery did not collect it ("Not Picked"): the seller has to ask again. */
  pickupFailedAt: string | null;
  pickupScheduledFor: string | null;
}

/** Delhivery refused a booking over Clowe's wallet: shown on every admin page until resolved. */
export interface CourierWalletAlert {
  /** Delhivery's words. */
  message: string;
  firstAt: string;
  lastAt: string;
  /** Refusals since the alert was raised. */
  count: number;
  /** The booking that was refused, e.g. "order CLW-2026-001234". */
  context: string | null;
}

export interface AdminShipmentPage {
  /** 'mock' or 'delhivery', and its environment: which courier is live. */
  provider: string;
  environment: string;
  total: number;
  page: number;
  pageSize: number;
  rows: AdminShipmentRow[];
}
