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
