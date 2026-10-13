import type { ShipmentStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// The courier, behind one interface. Delhivery is the only courier: the mock
// stands in for it in development and tests, and the Delhivery client talks
// to its staging or production API. Shapes follow Delhivery's API, in our
// units: paise, grams and millimetres.
// ---------------------------------------------------------------------------

export type ShippingMode = 'SURFACE' | 'EXPRESS';
export type ShipmentPayment = 'PREPAID' | 'COD';

/** A refusal or failure from the courier, in words a seller or admin can act on. */
export class ShippingProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** True when trying again later may work (timeouts, 5xx, rate limits). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ShippingProviderError';
  }
}

export interface PincodeServiceability {
  pincode: string;
  /** Delivers here at all. */
  serviceable: boolean;
  prepaid: boolean;
  cod: boolean;
  /** Collects forward shipments from here (seller pickup). */
  pickup: boolean;
  /** Collects returns from a customer here. */
  reversePickup: boolean;
  /** The most cash collected on delivery here, in paise; null when not stated. */
  codLimitPaise: number | null;
  city: string | null;
  state: string | null;
}

/** Delhivery's charge kinds: delivered forward, back to the seller (RTO), customer return (DTO). */
export type FreightKind = 'DELIVERED' | 'RTO' | 'DTO';

export interface FreightQuoteRequest {
  originPincode: string;
  destinationPincode: string;
  mode: ShippingMode;
  /** Chargeable weight: the larger of actual and volumetric. */
  weightGrams: number;
  kind: FreightKind;
  payment: ShipmentPayment;
  codAmountPaise?: number;
}

export interface FreightQuote {
  zone: string;
  chargedWeightGrams: number;
  freightPaise: number;
  codChargePaise: number;
  taxPaise: number;
  /** freight + COD charge + tax. */
  totalPaise: number;
}

export interface PostalAddress {
  line1: string;
  city: string;
  state: string;
  pincode: string;
}

/** A seller's pickup location, registered with the courier under our fixed name. */
export interface WarehouseInput {
  /** Fixed per seller (e.g. CLW-<id>); matched exactly, so it never changes. */
  name: string;
  /** The seller's registered business name. */
  registeredName: string;
  phone: string;
  email: string | null;
  address: PostalAddress;
  /** Where undelivered parcels go back to: the seller's own pickup address. */
  returnAddress: PostalAddress;
}

export interface WarehouseResult {
  name: string;
  /** False when an existing registration was updated. */
  created: boolean;
}

export interface ShipmentParty {
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
}

export interface ShipmentProduct {
  title: string;
  quantity: number;
  hsn: string | null;
}

export interface CreateShipmentRequest {
  /** Unique per shipment for the courier: our Shipment id. */
  reference: string;
  orderNumber: string;
  /** Pickup location: the seller's registered warehouse, and its pincode for estimates. */
  pickup: { warehouseName: string | null; pincode: string | null };
  consignee: ShipmentParty;
  payment: ShipmentPayment;
  /** Cash to collect on delivery; 0 for prepaid. */
  codAmountPaise: number;
  /** What the goods are worth to the buyer (the invoice value). */
  invoiceValuePaise: number;
  mode: ShippingMode;
  weightGrams: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  products: ShipmentProduct[];
  sellerGstin: string | null;
}

export interface CreatedShipment {
  awbNumber: string;
  courierName: string;
  /** Where a buyer follows the parcel; null when only our own tracking page applies. */
  trackingUrl: string | null;
  /** The courier's estimate at booking, when it gives one. */
  estimatedFreightPaise: number | null;
}

/** What a printed label needs beyond our own order data. */
export interface LabelData {
  awbNumber: string;
  /** The value the barcode encodes (Code 128). */
  barcodeValue: string;
  /** The courier's sort / routing code, printed large for its hubs. */
  sortCode: string | null;
  destinationHub: string | null;
}

export interface PickupRequest {
  warehouseName: string;
  pickupAt: Date;
  expectedPackages: number;
}

export interface PickupResult {
  pickupRequestId: string;
  scheduledFor: Date;
}

/** One courier scan, as the courier reported it. */
export interface TrackingScan {
  at: Date;
  /** Delhivery StatusType: UD (forward), DL (delivered), RT (RTO), PP/PU (reverse), CN (cancelled). */
  statusType: string;
  status: string;
  /** Scan code, e.g. an EOD-… failed-delivery reason; '' when none. */
  code: string;
  location: string | null;
  instructions: string | null;
}

export interface TrackingResult {
  awbNumber: string;
  status: ShipmentStatus;
  statusText: string;
  /** The weight the courier measured and bills on, once known. */
  chargedWeightGrams: number | null;
  scans: TrackingScan[];
}

/** What the seller or admin asks after a failed delivery (NDR). */
export type NdrAction = 'RE_ATTEMPT' | 'DEFER_DELIVERY' | 'EDIT_DETAILS';

export interface NdrRequest {
  action: NdrAction;
  /** DEFER_DELIVERY: the day to try again (up to 6 days out). */
  deferTo?: Date;
  /** EDIT_DETAILS: corrected contact details. */
  consignee?: Partial<Pick<ShipmentParty, 'name' | 'phone' | 'line1'>>;
}

export interface ReversePickupRequest {
  reference: string;
  orderNumber: string;
  /** Collected from the customer… */
  customer: ShipmentParty;
  /** …and delivered back to this seller warehouse. */
  warehouseName: string | null;
  valuePaise: number;
  weightGrams: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  products: ShipmentProduct[];
}

export interface ShippingProvider {
  /** 'mock' or 'delhivery'. */
  readonly name: string;
  /** 'mock', 'staging' or 'production': stored on every shipment it books. */
  readonly environment: string;
  /** The courier's name as buyers and sellers see it. */
  readonly courierName: string;

  checkPincode(pincode: string): Promise<PincodeServiceability>;
  quote(request: FreightQuoteRequest): Promise<FreightQuote>;
  upsertWarehouse(warehouse: WarehouseInput): Promise<WarehouseResult>;
  createShipment(request: CreateShipmentRequest): Promise<CreatedShipment>;
  getLabel(awbNumber: string): Promise<LabelData>;
  requestPickup(request: PickupRequest): Promise<PickupResult>;
  /** Up to 30 AWBs per call. */
  track(awbNumbers: string[]): Promise<TrackingResult[]>;
  cancelShipment(awbNumber: string): Promise<void>;
  /** Returns the courier's request id; the outcome shows up in later scans. */
  ndrAction(awbNumber: string, request: NdrRequest): Promise<{ requestId: string }>;
  createReversePickup(request: ReversePickupRequest): Promise<CreatedShipment>;
}

/** Most AWBs one tracking call takes (Delhivery's limit). */
export const TRACK_BATCH = 30;
