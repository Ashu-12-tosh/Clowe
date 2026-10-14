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
  type ShipmentParty,
  type ShippingProvider,
  type TrackingResult,
  type TrackingScan,
  type WarehouseInput,
  type WarehouseResult,
} from './ShippingProvider';

// ---------------------------------------------------------------------------
// Delhivery's B2C API (https://delhivery-express-api-doc.readme.io).
//
//   Serviceability  GET  /c/api/pin-codes/json/?filter_codes=
//   Freight         GET  /api/kinko/v1/invoice/charges/.json
//   Warehouse       POST /api/backend/clientwarehouse/create/ (…/edit/)
//   Book            POST /api/cmu/create.json   (format=json&data=…)
//   Label           GET  /api/p/packing_slip?wbns=
//   Pickup          POST /fm/request/new/
//   Track           GET  /api/v1/packages/json/?waybill=   (30 per call)
//   Cancel          POST /api/p/edit            { waybill, cancellation }
//   NDR             POST /api/p/update          { data: [{ waybill, act }] }
//
// Staging (staging-express.delhivery.com) is the default and the only host
// used unless DELHIVERY_ENV=production. Against production, anything that
// books, requests a pickup, cancels or registers — anything that can spend
// wallet money or move a real parcel — is refused unless
// DELHIVERY_PRODUCTION_WRITES=true as well. Every write is logged; the token
// never is.
//
// One request per call and never a retry: a booking that timed out may still
// have been made, and a retry could book (and bill) it twice.
//
// Field names follow the public docs. Where they were not documented (label
// fields, warehouse edit, NDR response) the mapping reads the likeliest name
// and is to be confirmed against staging responses.
// ---------------------------------------------------------------------------

export type DelhiveryEnvironment = 'staging' | 'production';

export const DELHIVERY_HOSTS: Record<DelhiveryEnvironment, string> = {
  staging: 'https://staging-express.delhivery.com',
  production: 'https://track.delhivery.com',
};

export interface DelhiveryConfig {
  token: string;
  environment: DelhiveryEnvironment;
  /** Production only: allow calls that book, pick up, cancel or register. */
  allowProductionWrites: boolean;
  timeoutMs?: number;
  /** For tests. */
  fetchImpl?: typeof fetch;
  /** Where write calls are recorded; console.log by default. */
  log?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;

const rupees = (paise: number) => Math.round(paise) / 100;
const paise = (value: unknown) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const str = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const cm = (mm: number | null) => (mm ? Math.round(mm / 10) : undefined);
const yes = (value: unknown) => str(value).trim().toUpperCase() === 'Y';

/** Delhivery's timestamps are Indian time, usually without an offset. */
export function delhiveryTime(value: unknown): Date {
  const s = str(value).trim();
  if (!s) return new Date(NaN);
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}+05:30`);
}

/** YYYY-MM-DD and HH:MM:SS in Indian time. */
function istParts(at: Date): { date: string; time: string } {
  const ist = new Date(at.getTime() + 330 * 60_000).toISOString();
  return { date: ist.slice(0, 10), time: ist.slice(11, 19) };
}

/** The reasons Delhivery gives for refusing, flattened to one line. */
function remarks(...values: unknown[]): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    else if (str(v).trim()) out.push(str(v).trim());
  };
  values.forEach(walk);
  return [...new Set(out)].join('; ');
}

/**
 * One shipment as Delhivery describes it — in a tracking reply or a pushed
 * webhook — as our tracking result. A push may carry only the current status,
 * without the scan history: that status is then its one scan.
 */
export function parseDelhiveryShipment(raw: unknown): TrackingResult | null {
  const s = raw as Json | undefined;
  if (!s || typeof s !== 'object' || !s.AWB) return null;
  const now = (s.Status ?? {}) as Json;
  const current = { statusType: str(now.StatusType), status: str(now.Status), code: str(now.StatusCode) };
  const history: TrackingScan[] = (Array.isArray(s.Scans) ? s.Scans : [])
    .map((x) => (x as Json).ScanDetail as Json | undefined)
    .filter((d): d is Json => !!d)
    .map((d) => ({
      at: delhiveryTime(d.ScanDateTime ?? d.StatusDateTime),
      statusType: str(d.ScanType),
      status: str(d.Scan),
      code: str(d.StatusCode),
      location: str(d.ScannedLocation) || null,
      instructions: str(d.Instructions) || null,
    }));
  const scans =
    history.length > 0 || !current.status
      ? history
      : [
          {
            at: delhiveryTime(now.StatusDateTime),
            ...current,
            location: str(now.StatusLocation) || null,
            instructions: str(now.Instructions) || null,
          },
        ];
  return {
    awbNumber: str(s.AWB),
    status: shipmentStatusFromScan(current),
    statusText: str(now.Instructions) || current.status,
    chargedWeightGrams: Number(s.ChargedWeight) || null,
    scans,
  };
}

export class DelhiveryShippingProvider implements ShippingProvider {
  readonly name = 'delhivery';
  readonly courierName = 'Delhivery';
  readonly environment: DelhiveryEnvironment;
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(private readonly config: DelhiveryConfig) {
    if (!config.token.trim()) throw new Error('Delhivery needs an API token');
    this.environment = config.environment;
    this.host = DELHIVERY_HOSTS[config.environment];
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.log = config.log ?? ((line) => console.log(line));
  }

  // --- Reads ---------------------------------------------------------------

  async checkPincode(pincode: string): Promise<PincodeServiceability> {
    const body = await this.get('/c/api/pin-codes/json/', { filter_codes: pincode });
    const codes = Array.isArray(body.delivery_codes) ? body.delivery_codes : [];
    const pc = (codes[0] as Json | undefined)?.postal_code as Json | undefined;
    if (!pc) {
      return { pincode, serviceable: false, prepaid: false, cod: false, pickup: false, reversePickup: false, codLimitPaise: null, city: null, state: null };
    }
    const cod = yes(pc.cod) || yes(pc.cash);
    return {
      pincode,
      serviceable: yes(pc.pre_paid) || cod,
      prepaid: yes(pc.pre_paid),
      cod,
      // Delhivery's "pickup" flag; whether it covers seller pickup as well as
      // customer returns is to be confirmed.
      pickup: yes(pc.pickup),
      reversePickup: yes(pc.pickup),
      // Live replies carry max_amount 0 where no COD limit is set (e.g. 110001).
      codLimitPaise: cod && Number(pc.max_amount) > 0 ? paise(pc.max_amount) : null,
      city: str(pc.district) || str(pc.city) || null,
      state: str(pc.state_code) || null,
    };
  }

  async quote(request: FreightQuoteRequest): Promise<FreightQuote> {
    const reply = await this.get('/api/kinko/v1/invoice/charges/.json', {
      md: request.mode === 'EXPRESS' ? 'E' : 'S',
      cgm: String(Math.max(1, Math.round(request.weightGrams))),
      ss: request.kind === 'DELIVERED' ? 'Delivered' : request.kind,
      o_pin: request.originPincode,
      d_pin: request.destinationPincode,
      // Not in the public docs, but the live API honours both: with them it
      // adds the COD charge (2 % of the amount, at least ₹40).
      pt: request.payment === 'COD' ? 'COD' : 'Pre-paid',
      ...(request.payment === 'COD' && request.codAmountPaise ? { cod: String(rupees(request.codAmountPaise)) } : {}),
    });
    const row = (Array.isArray(reply) ? reply[0] : reply) as Json | undefined;
    if (!row || (row.total_amount == null && row.gross_amount == null)) {
      throw new ShippingProviderError(`Delhivery gave no rate: ${remarks(row?.error, row?.message) || 'no data'}`, 'NO_RATE');
    }
    // For RTO the totals are the forward charge and the RTO charge together.
    const charge = { DELIVERED: row.charge_DL, RTO: row.charge_RTO, DTO: row.charge_DTO }[request.kind];
    const gross = paise(row.gross_amount);
    const total = paise(row.total_amount ?? row.gross_amount);
    return {
      zone: str(row.zone),
      chargedWeightGrams: Number(row.charged_weight) || request.weightGrams,
      freightPaise: paise(charge),
      codChargePaise: paise(row.charge_COD),
      taxPaise: Math.max(0, total - gross),
      totalPaise: total,
    };
  }

  async getLabel(awbNumber: string): Promise<LabelData> {
    const body = await this.get('/api/p/packing_slip', { wbns: awbNumber });
    const pkg = (Array.isArray(body.packages) ? body.packages[0] : undefined) as Json | undefined;
    if (!pkg) throw new ShippingProviderError(`Delhivery has no label for AWB ${awbNumber}`, 'NO_LABEL');
    return {
      awbNumber: str(pkg.wbn) || awbNumber,
      barcodeValue: str(pkg.wbn) || awbNumber,
      sortCode: str(pkg.sort_code) || null,
      destinationHub: str(pkg.destination) || null,
    };
  }

  async track(awbNumbers: string[]): Promise<TrackingResult[]> {
    if (awbNumbers.length === 0) return [];
    if (awbNumbers.length > TRACK_BATCH) {
      throw new ShippingProviderError(`Track at most ${TRACK_BATCH} AWBs per call`, 'TOO_MANY_AWBS');
    }
    const body = await this.get('/api/v1/packages/json/', { waybill: awbNumbers.join(',') });
    const data = Array.isArray(body.ShipmentData) ? body.ShipmentData : [];
    return data.flatMap((entry) => {
      const parsed = parseDelhiveryShipment((entry as Json).Shipment);
      return parsed ? [parsed] : [];
    });
  }

  // --- Writes (refused against production unless switched on) ---------------

  async upsertWarehouse(warehouse: WarehouseInput): Promise<WarehouseResult> {
    if (warehouse.name.includes('_')) {
      throw new ShippingProviderError('Warehouse names may not contain an underscore', 'INVALID_WAREHOUSE_NAME');
    }
    const payload = {
      name: warehouse.name,
      registered_name: warehouse.registeredName,
      phone: warehouse.phone,
      email: warehouse.email ?? '',
      address: warehouse.address.line1,
      city: warehouse.address.city,
      pin: warehouse.address.pincode,
      country: 'India',
      return_address: warehouse.returnAddress.line1,
      return_city: warehouse.returnAddress.city,
      return_state: warehouse.returnAddress.state,
      return_pin: warehouse.returnAddress.pincode,
      return_country: 'India',
    };
    const created = await this.post('/api/backend/clientwarehouse/create/', payload, `warehouse ${warehouse.name}`);
    if (created.success !== false) return { name: warehouse.name, created: true };
    const why = remarks(created.error, created.message, created.data);
    if (!/already exists/i.test(why)) throw new ShippingProviderError(`Delhivery refused the pickup address: ${why}`, 'WAREHOUSE_REFUSED');
    // Registered before: update it in place. Which fields edit accepts is undocumented.
    const edited = await this.post(
      '/api/backend/clientwarehouse/edit/',
      { name: warehouse.name, registered_name: warehouse.registeredName, address: payload.address, pin: payload.pin, phone: payload.phone },
      `warehouse ${warehouse.name} (edit)`,
    );
    if (edited.success === false) {
      throw new ShippingProviderError(
        `Delhivery refused the pickup address change: ${remarks(edited.error, edited.message)}`,
        'WAREHOUSE_REFUSED',
      );
    }
    return { name: warehouse.name, created: false };
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreatedShipment> {
    if (!request.pickup.warehouseName) {
      throw new ShippingProviderError('The pickup address is not registered with Delhivery yet', 'NO_WAREHOUSE');
    }
    const awb = await this.book(
      {
        ...this.party(request.consignee),
        order: request.reference,
        payment_mode: request.payment === 'COD' ? 'COD' : 'Prepaid',
        cod_amount: request.payment === 'COD' ? rupees(request.codAmountPaise) : 0,
        total_amount: rupees(request.invoiceValuePaise),
        products_desc: request.products.map((p) => `${p.title} x${p.quantity}`).join(', ').slice(0, 300),
        hsn_code: [...new Set(request.products.map((p) => p.hsn).filter(Boolean))].join(','),
        quantity: request.products.reduce((sum, p) => sum + p.quantity, 0),
        weight: request.weightGrams,
        shipment_length: cm(request.lengthMm),
        shipment_width: cm(request.widthMm),
        shipment_height: cm(request.heightMm),
        shipping_mode: request.mode === 'EXPRESS' ? 'Express' : 'Surface',
        seller_gst_tin: request.sellerGstin ?? '',
        order_date: new Date().toISOString().slice(0, 10),
        waybill: '',
      },
      request.pickup.warehouseName,
      `book ${request.orderNumber} ref ${request.reference}`,
    );
    // Buyers follow it on our own tracking page, which shows Delhivery's scans.
    return {
      awbNumber: awb,
      courierName: this.courierName,
      trackingUrl: `/track?orderNumber=${encodeURIComponent(request.orderNumber)}`,
      estimatedFreightPaise: null,
    };
  }

  async createReversePickup(request: ReversePickupRequest): Promise<CreatedShipment> {
    if (!request.warehouseName) {
      throw new ShippingProviderError('The return address is not registered with Delhivery yet', 'NO_WAREHOUSE');
    }
    const awb = await this.book(
      {
        ...this.party(request.customer),
        order: request.reference,
        payment_mode: 'Pickup',
        cod_amount: 0,
        total_amount: rupees(request.valuePaise),
        products_desc: request.products.map((p) => `${p.title} x${p.quantity}`).join(', ').slice(0, 300),
        quantity: request.products.reduce((sum, p) => sum + p.quantity, 0),
        weight: request.weightGrams,
        shipment_length: cm(request.lengthMm),
        shipment_width: cm(request.widthMm),
        shipment_height: cm(request.heightMm),
        order_date: new Date().toISOString().slice(0, 10),
        waybill: '',
      },
      request.warehouseName,
      `reverse pickup ${request.orderNumber} ref ${request.reference}`,
    );
    return { awbNumber: awb, courierName: this.courierName, trackingUrl: null, estimatedFreightPaise: null };
  }

  async requestPickup(request: PickupRequest): Promise<PickupResult> {
    const { date, time } = istParts(request.pickupAt);
    const body = await this.post(
      '/fm/request/new/',
      { pickup_location: request.warehouseName, pickup_date: date, pickup_time: time, expected_package_count: request.expectedPackages },
      `pickup ${request.warehouseName} ${date} ${time} x${request.expectedPackages}`,
    );
    const id = str(body.pickup_id ?? body.pickupId ?? body.id);
    if (!id) throw new ShippingProviderError(`Delhivery refused the pickup: ${remarks(body.error, body.message, body.pr_exist) || 'no pickup id'}`, 'PICKUP_REFUSED');
    return { pickupRequestId: id, scheduledFor: request.pickupAt };
  }

  async cancelShipment(awbNumber: string): Promise<void> {
    const body = await this.post('/api/p/edit', { waybill: awbNumber, cancellation: 'true' }, `cancel ${awbNumber}`);
    if (body.status !== true && str(body.status).toLowerCase() !== 'true') {
      throw new ShippingProviderError(`Delhivery refused the cancellation: ${remarks(body.remark, body.error) || 'no reason given'}`, 'NOT_CANCELLABLE');
    }
  }

  async ndrAction(awbNumber: string, request: NdrRequest): Promise<{ requestId: string }> {
    const act = { RE_ATTEMPT: 'RE-ATTEMPT', DEFER_DELIVERY: 'DEFER_DLV', EDIT_DETAILS: 'EDIT_DETAILS' }[request.action];
    const actionData =
      request.action === 'DEFER_DELIVERY' && request.deferTo
        ? { deferred_date: istParts(request.deferTo).date }
        : request.action === 'EDIT_DETAILS' && request.consignee
          ? { name: request.consignee.name, phone: request.consignee.phone, add: request.consignee.line1 }
          : undefined;
    const body = await this.post(
      '/api/p/update',
      { data: [{ waybill: awbNumber, act, ...(actionData ? { action_data: actionData } : {}) }] },
      `ndr ${act} ${awbNumber}`,
    );
    const id = str(body.request_id ?? body.requestId ?? body.UPL);
    if (!id) throw new ShippingProviderError(`Delhivery refused the request: ${remarks(body.error, body.message) || 'no request id'}`, 'NDR_REFUSED');
    return { requestId: id };
  }

  // --- Plumbing --------------------------------------------------------------

  private party(p: ShipmentParty) {
    return {
      name: p.name,
      add: [p.line1, p.line2].filter(Boolean).join(', '),
      pin: p.pincode,
      city: p.city,
      state: p.state,
      country: 'India',
      phone: p.phone,
    };
  }

  /** Book one parcel (forward or reverse) and return its AWB. */
  private async book(shipment: Json, warehouseName: string, what: string): Promise<string> {
    const data = JSON.stringify({ shipments: [shipment], pickup_location: { name: warehouseName } });
    // Delhivery's docs say this endpoint must get format=json&data=<json>.
    const body = await this.request('POST', '/api/cmu/create.json', `format=json&data=${encodeURIComponent(data)}`, {
      write: what,
      contentType: 'application/x-www-form-urlencoded',
    });
    // HTTP 200 even when it refuses: the answer is in each package.
    const pkg = (Array.isArray(body.packages) ? body.packages[0] : undefined) as Json | undefined;
    const awb = str(pkg?.waybill);
    if (!awb || (pkg && str(pkg.status).toLowerCase() !== 'success')) {
      throw new ShippingProviderError(
        `Delhivery refused the booking: ${remarks(pkg?.remarks, body.rmk, body.error) || 'no reason given'}`,
        'BOOKING_REFUSED',
      );
    }
    this.log(`[clowe-api] delhivery ${this.environment}: ${what} → AWB ${awb}`);
    return awb;
  }

  private get(path: string, query: Record<string, string>): Promise<Json> {
    return this.request('GET', `${path}?${new URLSearchParams(query).toString()}`);
  }

  private post(path: string, payload: unknown, what: string): Promise<Json> {
    return this.request('POST', path, JSON.stringify(payload), { write: what, contentType: 'application/json' });
  }

  private async request(
    method: 'GET' | 'POST',
    pathAndQuery: string,
    body?: string,
    opts: { write?: string; contentType?: string } = {},
  ): Promise<Json> {
    if (opts.write && this.environment === 'production' && !this.config.allowProductionWrites) {
      throw new ShippingProviderError(
        'Booking, pickups and cancellations on live Delhivery are switched off (DELHIVERY_PRODUCTION_WRITES)',
        'PRODUCTION_WRITES_DISABLED',
      );
    }
    if (opts.write) this.log(`[clowe-api] delhivery ${this.environment}: ${method} ${pathAndQuery.split('?')[0]} — ${opts.write}`);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}${pathAndQuery}`, {
        method,
        headers: {
          Authorization: `Token ${this.config.token}`,
          Accept: 'application/json',
          ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ShippingProviderError(
        timedOut ? 'Delhivery did not answer in time' : 'Could not reach Delhivery',
        timedOut ? 'TIMEOUT' : 'NETWORK',
        true,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new ShippingProviderError('Delhivery rejected the API token', 'AUTH');
    }
    if (res.status === 429) throw new ShippingProviderError('Delhivery is rate-limiting us; try again shortly', 'RATE_LIMITED', true);
    if (res.status >= 500) throw new ShippingProviderError(`Delhivery is having trouble (HTTP ${res.status})`, 'UPSTREAM', true);

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ShippingProviderError(`Delhivery sent an unreadable reply (HTTP ${res.status})`, 'BAD_RESPONSE');
    }
    if (res.status >= 400) {
      throw new ShippingProviderError(
        `Delhivery refused the request (HTTP ${res.status}): ${remarks((parsed as Json)?.error, (parsed as Json)?.message, (parsed as Json)?.detail) || 'no reason given'}`,
        'REFUSED',
      );
    }
    // The rate endpoint answers with a bare array; callers check.
    return parsed as Json;
  }
}
