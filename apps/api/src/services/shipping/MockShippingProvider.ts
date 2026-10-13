import { randomInt } from 'node:crypto';
import type { ShipmentStatus } from '@prisma/client';
import { shipmentStatusFromScan } from './scanStatus';
import {
  ShippingProviderError,
  TRACK_BATCH,
  type CreateShipmentRequest,
  type CreatedShipment,
  type FreightQuote,
  type FreightQuoteRequest,
  type LabelData,
  type NdrRequest,
  type PickupRequest,
  type PickupResult,
  type PincodeServiceability,
  type ReversePickupRequest,
  type ShippingProvider,
  type TrackingResult,
  type TrackingScan,
  type WarehouseInput,
  type WarehouseResult,
} from './ShippingProvider';

// ---------------------------------------------------------------------------
// Delhivery, imitated: no network, no money. It keeps what it booked in
// memory and answers the way Delhivery does, so the flows above it can be
// built and tested before a token exists. Rules worth knowing:
//
// - Pincodes: six digits, not starting with 0. 999999 is not served at all;
//   888888 is served prepaid only (no COD). COD is capped at ₹50,000.
// - Freight: zone from the two pincodes (A same city … E remote), per 500 g
//   slab, Express 1.6×, COD charge ₹40 or 2 %, 18 % GST. Indicative only.
// - Warehouse names may not contain an underscore (Delhivery refuses them).
// - Each shipment reference books once; a second booking is refused.
// - simulate() moves a booked parcel along, as courier scans would.
// ---------------------------------------------------------------------------

const COURIER = 'Delhivery';
const COD_LIMIT_PAISE = 5_000_000;
const NOT_SERVED = '999999';
const PREPAID_ONLY = '888888';

/** First-500 g and each further 500 g, in paise, per zone (surface). */
const ZONE_RATES: Record<string, [number, number]> = {
  A: [3_800, 3_200],
  B: [4_500, 3_800],
  C: [5_500, 4_800],
  D: [6_500, 5_600],
  E: [8_700, 7_500],
};
/** Jammu & Kashmir, Himachal, the North East, Andaman: Delhivery's special zone. */
const REMOTE_PREFIXES = ['17', '18', '19', '74', '78', '79'];

export function mockZone(origin: string, destination: string): string {
  if (REMOTE_PREFIXES.some((p) => destination.startsWith(p))) return 'E';
  if (origin.slice(0, 3) === destination.slice(0, 3)) return 'A';
  if (origin.slice(0, 2) === destination.slice(0, 2)) return 'B';
  if (origin[0] === destination[0]) return 'C';
  return 'D';
}

/** What simulate() can make happen to a booked parcel. */
export type MockEvent =
  | 'PICKED_UP'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERY_FAILED'
  | 'DELIVERED'
  | 'RTO'
  | 'RTO_DELIVERED'
  | 'LOST';

const EVENT_SCANS: Record<MockEvent, Omit<TrackingScan, 'at' | 'location' | 'instructions'>> = {
  PICKED_UP: { statusType: 'UD', status: 'In Transit', code: 'X-PPOM' },
  OUT_FOR_DELIVERY: { statusType: 'UD', status: 'Dispatched', code: 'X-DDD3FD' },
  DELIVERY_FAILED: { statusType: 'UD', status: 'Pending', code: 'EOD-11' },
  DELIVERED: { statusType: 'DL', status: 'Delivered', code: 'EOD-38' },
  RTO: { statusType: 'RT', status: 'In Transit', code: 'RT-101' },
  RTO_DELIVERED: { statusType: 'DL', status: 'RTO', code: 'RT-110' },
  LOST: { statusType: 'UD', status: 'Lost', code: 'LT-100' },
};

interface MockParcel {
  awbNumber: string;
  reference: string;
  reverse: boolean;
  destination: ShipmentPartyLike;
  zone: string | null;
  weightGrams: number;
  scans: TrackingScan[];
}

interface ShipmentPartyLike {
  city: string;
  pincode: string;
}

export class MockShippingProvider implements ShippingProvider {
  readonly name = 'mock';
  readonly environment = 'mock';
  readonly courierName = COURIER;

  private readonly parcels = new Map<string, MockParcel>();
  private readonly references = new Set<string>();
  private readonly warehouses = new Map<string, WarehouseInput>();
  private requests = 0;
  private booked = 0;

  async checkPincode(pincode: string): Promise<PincodeServiceability> {
    const valid = /^[1-9]\d{5}$/.test(pincode) && pincode !== NOT_SERVED;
    return {
      pincode,
      serviceable: valid,
      prepaid: valid,
      cod: valid && pincode !== PREPAID_ONLY,
      pickup: valid,
      reversePickup: valid,
      codLimitPaise: valid && pincode !== PREPAID_ONLY ? COD_LIMIT_PAISE : null,
      city: null,
      state: null,
    };
  }

  async quote(request: FreightQuoteRequest): Promise<FreightQuote> {
    for (const pin of [request.originPincode, request.destinationPincode]) {
      if (!(await this.checkPincode(pin)).serviceable) {
        throw new ShippingProviderError(`Pincode ${pin} is not serviceable`, 'PINCODE_NOT_SERVICEABLE');
      }
    }
    if (request.weightGrams <= 0) throw new ShippingProviderError('Weight must be more than 0 g', 'INVALID_WEIGHT');
    const zone = mockZone(request.originPincode, request.destinationPincode);
    const slabs = Math.ceil(request.weightGrams / 500);
    const [first, extra] = ZONE_RATES[zone]!;
    let freight = first + (slabs - 1) * extra;
    if (request.mode === 'EXPRESS') freight = Math.round(freight * 1.6);
    if (request.kind === 'DTO') freight = Math.round(freight * 1.2);
    const codCharge =
      request.kind === 'DELIVERED' && request.payment === 'COD'
        ? Math.max(4_000, Math.round((request.codAmountPaise ?? 0) * 0.02))
        : 0;
    const tax = Math.round((freight + codCharge) * 0.18);
    return {
      zone,
      chargedWeightGrams: slabs * 500,
      freightPaise: freight,
      codChargePaise: codCharge,
      taxPaise: tax,
      totalPaise: freight + codCharge + tax,
    };
  }

  async upsertWarehouse(warehouse: WarehouseInput): Promise<WarehouseResult> {
    if (warehouse.name.includes('_')) {
      throw new ShippingProviderError('Warehouse names may not contain an underscore', 'INVALID_WAREHOUSE_NAME');
    }
    if (!(await this.checkPincode(warehouse.address.pincode)).pickup) {
      throw new ShippingProviderError(
        `Pickup is not available at pincode ${warehouse.address.pincode}`,
        'PICKUP_NOT_SERVICEABLE',
      );
    }
    const created = !this.warehouses.has(warehouse.name);
    this.warehouses.set(warehouse.name, warehouse);
    return { name: warehouse.name, created };
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreatedShipment> {
    this.claimReference(request.reference);
    const destination = await this.checkPincode(request.consignee.pincode);
    if (!destination.serviceable) {
      this.references.delete(request.reference);
      throw new ShippingProviderError(
        `Delhivery does not deliver to pincode ${request.consignee.pincode}`,
        'PINCODE_NOT_SERVICEABLE',
      );
    }
    if (request.payment === 'COD' && (!destination.cod || request.codAmountPaise > (destination.codLimitPaise ?? 0))) {
      this.references.delete(request.reference);
      throw new ShippingProviderError(
        `Cash on delivery is not available for this amount at pincode ${request.consignee.pincode}`,
        'COD_NOT_AVAILABLE',
      );
    }
    if (request.weightGrams <= 0) {
      this.references.delete(request.reference);
      throw new ShippingProviderError('Weight must be more than 0 g', 'INVALID_WEIGHT');
    }

    const estimate = request.pickup.pincode
      ? await this.quote({
          originPincode: request.pickup.pincode,
          destinationPincode: request.consignee.pincode,
          mode: request.mode,
          weightGrams: request.weightGrams,
          kind: 'DELIVERED',
          payment: request.payment,
          codAmountPaise: request.codAmountPaise,
        }).catch(() => null)
      : null;
    const awbNumber = this.nextAwb();
    this.parcels.set(awbNumber, {
      awbNumber,
      reference: request.reference,
      reverse: false,
      destination: request.consignee,
      zone: estimate?.zone ?? null,
      weightGrams: request.weightGrams,
      scans: [this.scan({ statusType: 'UD', status: 'Manifested', code: 'X-UCI' })],
    });
    return {
      awbNumber,
      courierName: COURIER,
      // Mock tracking points at our own public tracking page.
      trackingUrl: `/track?orderNumber=${encodeURIComponent(request.orderNumber)}`,
      estimatedFreightPaise: estimate?.totalPaise ?? null,
    };
  }

  async getLabel(awbNumber: string): Promise<LabelData> {
    const parcel = this.parcels.get(awbNumber);
    return {
      awbNumber,
      barcodeValue: awbNumber,
      sortCode: parcel ? `MOCK/${parcel.zone ?? 'X'}/${parcel.destination.pincode.slice(0, 3)}` : null,
      destinationHub: parcel ? `${parcel.destination.city} (mock hub)` : null,
    };
  }

  async requestPickup(request: PickupRequest): Promise<PickupResult> {
    if (!request.warehouseName) throw new ShippingProviderError('No pickup location given', 'NO_WAREHOUSE');
    if (request.expectedPackages < 1) throw new ShippingProviderError('Expect at least one package', 'INVALID_COUNT');
    this.requests += 1;
    return { pickupRequestId: `MOCK-PU-${this.requests}`, scheduledFor: request.pickupAt };
  }

  async track(awbNumbers: string[]): Promise<TrackingResult[]> {
    if (awbNumbers.length > TRACK_BATCH) {
      throw new ShippingProviderError(`Track at most ${TRACK_BATCH} AWBs per call`, 'TOO_MANY_AWBS');
    }
    return awbNumbers.flatMap((awb) => {
      const parcel = this.parcels.get(awb);
      if (!parcel) return [];
      const last = parcel.scans[parcel.scans.length - 1]!;
      return [
        {
          awbNumber: awb,
          status: shipmentStatusFromScan(last),
          statusText: last.status,
          chargedWeightGrams: parcel.scans.length > 1 ? Math.ceil(parcel.weightGrams / 500) * 500 : null,
          scans: [...parcel.scans],
        },
      ];
    });
  }

  async cancelShipment(awbNumber: string): Promise<void> {
    const parcel = this.parcel(awbNumber);
    const status = this.status(parcel);
    if (status === 'CREATED' || status === 'PICKUP_REQUESTED') {
      parcel.scans.push(this.scan({ statusType: 'CN', status: 'Canceled', code: 'X-CNCL' }));
      return;
    }
    // Once picked up, a cancelled parcel goes back to the seller.
    if (status === 'IN_TRANSIT' || status === 'OUT_FOR_DELIVERY' || status === 'DELIVERY_FAILED') {
      parcel.scans.push(this.scan(EVENT_SCANS.RTO));
      return;
    }
    throw new ShippingProviderError(`A shipment that is ${status.toLowerCase()} can't be cancelled`, 'NOT_CANCELLABLE');
  }

  async ndrAction(awbNumber: string, request: NdrRequest): Promise<{ requestId: string }> {
    const parcel = this.parcel(awbNumber);
    if (this.status(parcel) !== 'DELIVERY_FAILED') {
      throw new ShippingProviderError('Only a failed delivery can be re-attempted or deferred', 'NDR_NOT_ALLOWED');
    }
    if (request.action === 'DEFER_DELIVERY') {
      const days = request.deferTo ? (request.deferTo.getTime() - Date.now()) / 86_400_000 : -1;
      if (days < 0 || days > 6) throw new ShippingProviderError('Defer delivery by up to 6 days', 'NDR_BAD_DATE');
    }
    parcel.scans.push(this.scan({ statusType: 'UD', status: 'Pending', code: `X-NDR-${request.action}` }));
    this.requests += 1;
    return { requestId: `MOCK-NDR-${this.requests}` };
  }

  async createReversePickup(request: ReversePickupRequest): Promise<CreatedShipment> {
    this.claimReference(request.reference);
    if (!(await this.checkPincode(request.customer.pincode)).reversePickup) {
      this.references.delete(request.reference);
      throw new ShippingProviderError(
        `Delhivery can't collect returns at pincode ${request.customer.pincode}`,
        'PINCODE_NOT_SERVICEABLE',
      );
    }
    const awbNumber = this.nextAwb();
    this.parcels.set(awbNumber, {
      awbNumber,
      reference: request.reference,
      reverse: true,
      destination: request.customer,
      zone: null,
      weightGrams: request.weightGrams,
      scans: [this.scan({ statusType: 'PP', status: 'Open', code: 'X-PPONM' })],
    });
    return { awbNumber, courierName: COURIER, trackingUrl: null, estimatedFreightPaise: null };
  }

  /** Development and tests only: move a booked parcel along as a courier scan would. */
  simulate(awbNumber: string, event: MockEvent, at = new Date()): void {
    const parcel = this.parcel(awbNumber);
    if (parcel.reverse) {
      const reverse: Partial<Record<MockEvent, Omit<TrackingScan, 'at' | 'location' | 'instructions'>>> = {
        PICKED_UP: { statusType: 'PU', status: 'In Transit', code: 'X-PU' },
        DELIVERED: { statusType: 'DL', status: 'DTO', code: 'X-DTO' },
      };
      const scan = reverse[event];
      if (!scan) throw new Error(`A reverse pickup can't be simulated as ${event}`);
      parcel.scans.push({ ...scan, at, location: null, instructions: null });
      return;
    }
    parcel.scans.push({ ...EVENT_SCANS[event], at, location: `${parcel.destination.city} hub`, instructions: null });
  }

  private claimReference(reference: string): void {
    if (this.references.has(reference)) {
      throw new ShippingProviderError(`Shipment ${reference} is already booked`, 'DUPLICATE_REFERENCE');
    }
    this.references.add(reference);
  }

  /** Unique across bookings: AWBs are unique on shipments. */
  private nextAwb(): string {
    this.booked = (this.booked + 1) % 1000;
    return `AWB${Date.now().toString().slice(-8)}${randomInt(10, 100)}${String(this.booked).padStart(3, '0')}`;
  }

  private parcel(awbNumber: string): MockParcel {
    const parcel = this.parcels.get(awbNumber);
    if (!parcel) throw new ShippingProviderError(`No shipment with AWB ${awbNumber}`, 'UNKNOWN_AWB');
    return parcel;
  }

  private status(parcel: MockParcel): ShipmentStatus {
    return shipmentStatusFromScan(parcel.scans[parcel.scans.length - 1]!);
  }

  private scan(fields: Omit<TrackingScan, 'at' | 'location' | 'instructions'>): TrackingScan {
    return { ...fields, at: new Date(), location: null, instructions: null };
  }
}
