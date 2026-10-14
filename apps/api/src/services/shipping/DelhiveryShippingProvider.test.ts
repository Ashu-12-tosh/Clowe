import { describe, expect, it, vi } from 'vitest';
import { DelhiveryShippingProvider, delhiveryTime, type DelhiveryConfig } from './DelhiveryShippingProvider';
import { ShippingProviderError, type CreateShipmentRequest } from './ShippingProvider';

/**
 * Delhivery's answers mapped to ours, with fetch stubbed: no network, no
 * wallet. Reply shapes follow Delhivery's public docs.
 */

const TOKEN = 'test-token-0123456789abcdef';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stub(...replies: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function provider(fetchImpl: typeof fetch, extra: Partial<DelhiveryConfig> = {}) {
  const lines: string[] = [];
  const p = new DelhiveryShippingProvider({
    token: TOKEN,
    environment: 'staging',
    allowProductionWrites: false,
    fetchImpl,
    log: (line) => lines.push(line),
    ...extra,
  });
  return { p, lines };
}

const booking = (over: Partial<CreateShipmentRequest> = {}): CreateShipmentRequest => ({
  reference: 'shp_123',
  orderNumber: 'CLW-2026-000777',
  pickup: { warehouseName: 'CLW-seller1', pincode: '110001' },
  consignee: { name: 'Asha Rao', phone: '9000000001', line1: '12 MG Road', line2: 'Flat 4', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  payment: 'COD',
  codAmountPaise: 86_550,
  invoiceValuePaise: 86_550,
  mode: 'SURFACE',
  weightGrams: 900,
  lengthMm: 305,
  widthMm: 250,
  heightMm: 40,
  products: [
    { title: 'Tee', quantity: 2, hsn: '6109' },
    { title: 'Cap', quantity: 1, hsn: '6505' },
  ],
  sellerGstin: '27ABCDE1234F1Z5',
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<ShippingProviderError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ShippingProviderError);
  return err as ShippingProviderError;
}

describe('talking to Delhivery', () => {
  it('uses staging by default, with the token in the Authorization header', async () => {
    const { fetchImpl, calls } = stub({ body: { delivery_codes: [] } });
    await provider(fetchImpl).p.checkPincode('411001');
    expect(calls[0]!.url).toBe('https://staging-express.delhivery.com/c/api/pin-codes/json/?filter_codes=411001');
    expect(calls[0]!.headers.Authorization).toBe(`Token ${TOKEN}`);
  });

  it('reads production from track.delhivery.com, only when configured so', async () => {
    const { fetchImpl, calls } = stub({ body: { delivery_codes: [] } });
    await provider(fetchImpl, { environment: 'production' }).p.checkPincode('411001');
    expect(calls[0]!.url.startsWith('https://track.delhivery.com/')).toBe(true);
  });

  it('refuses every write against production unless production writes are switched on — without calling Delhivery', async () => {
    const { fetchImpl, calls } = stub({ body: {} });
    const { p } = provider(fetchImpl, { environment: 'production' });
    const writes: Promise<unknown>[] = [
      p.createShipment(booking()),
      p.requestPickup({ warehouseName: 'CLW-seller1', pickupAt: new Date(), expectedPackages: 1 }),
      p.cancelShipment('1234567890123'),
      p.ndrAction('1234567890123', { action: 'RE_ATTEMPT' }),
      p.upsertWarehouse({
        name: 'CLW-seller1', registeredName: 'Shop', phone: '9000000000', email: null,
        address: { line1: '1 Road', city: 'Delhi', state: 'Delhi', pincode: '110001' },
        returnAddress: { line1: '1 Road', city: 'Delhi', state: 'Delhi', pincode: '110001' },
      }),
      p.createReversePickup({
        reference: 'r1', orderNumber: 'CLW-1', customer: booking().consignee, warehouseName: 'CLW-seller1',
        valuePaise: 100, weightGrams: 500, lengthMm: null, widthMm: null, heightMm: null, products: [],
      }),
    ];
    for (const w of writes) expect((await refusal(w)).code).toBe('PRODUCTION_WRITES_DISABLED');
    expect(calls).toHaveLength(0);
  });

  it('allows production writes only with the explicit switch', async () => {
    const { fetchImpl, calls } = stub({ body: { status: true } });
    await provider(fetchImpl, { environment: 'production', allowProductionWrites: true }).p.cancelShipment('1234567890123');
    expect(calls[0]!.url).toBe('https://track.delhivery.com/api/p/edit');
  });

  it('never writes the token to the log, and logs every write', async () => {
    const { fetchImpl } = stub({ body: { success: true, packages: [{ waybill: '1490810000001', status: 'Success' }] } });
    const { p, lines } = provider(fetchImpl);
    await p.createShipment(booking());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).toContain('1490810000001');
  });

  it('maps HTTP failures: bad token, rate limit, outage, garbage, timeouts — none retried', async () => {
    for (const [status, body, code, retryable] of [
      [401, { detail: 'Invalid token' }, 'AUTH', false],
      [429, {}, 'RATE_LIMITED', true],
      [502, 'Bad Gateway', 'UPSTREAM', true],
      [200, '<html>', 'BAD_RESPONSE', false],
      [400, { error: 'pin missing' }, 'REFUSED', false],
    ] as const) {
      const { fetchImpl, calls } = stub({ status, body });
      const err = await refusal(provider(fetchImpl).p.checkPincode('411001'));
      expect([err.code, err.retryable], String(status)).toEqual([code, retryable]);
      expect(calls).toHaveLength(1);
    }
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect((await refusal(provider(timeout).p.track(['1']))).code).toBe('TIMEOUT');
  });
});

describe('serviceability and rates', () => {
  it('reads a pincode’s flags and COD limit; an empty list means not served', async () => {
    const { fetchImpl } = stub({
      body: { delivery_codes: [{ postal_code: { pin: 411001, district: 'Pune', state_code: 'MH', pre_paid: 'Y', cod: 'Y', cash: 'Y', pickup: 'Y', repl: 'Y', max_amount: 25000 } }] },
    });
    expect(await provider(fetchImpl).p.checkPincode('411001')).toEqual({
      pincode: '411001', serviceable: true, prepaid: true, cod: true, pickup: true, reversePickup: true,
      codLimitPaise: 2_500_000, city: 'Pune', state: 'MH',
    });
    // As the live API answers for 110001: COD allowed, max_amount 0 — no limit set.
    const unlimited = stub({
      body: { delivery_codes: [{ postal_code: { pin: 110001, district: 'New Delhi', state_code: 'DL', pre_paid: 'Y', cod: 'Y', cash: 'Y', pickup: 'Y', repl: 'Y', max_amount: 0 } }] },
    });
    expect(await provider(unlimited.fetchImpl).p.checkPincode('110001')).toMatchObject({ cod: true, codLimitPaise: null });
    const none = stub({ body: { delivery_codes: [] } });
    expect(await provider(none.fetchImpl).p.checkPincode('999999')).toMatchObject({ serviceable: false, cod: false, codLimitPaise: null });
  });

  it('asks for the documented rate parameters and reads the charges in paise', async () => {
    const { fetchImpl, calls } = stub({
      body: [{ zone: 'D', charged_weight: 1000, charge_DL: 65, charge_RTO: 65, charge_DTO: 78, charge_COD: 40, gross_amount: 112.5, total_amount: 132.75 }],
    });
    const q = await provider(fetchImpl).p.quote({
      originPincode: '110001', destinationPincode: '411001', mode: 'EXPRESS', weightGrams: 900, kind: 'RTO', payment: 'PREPAID',
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/kinko/v1/invoice/charges/.json');
    expect(Object.fromEntries(url.searchParams)).toEqual({ md: 'E', cgm: '900', ss: 'RTO', o_pin: '110001', d_pin: '411001', pt: 'Pre-paid' });
    expect(q).toEqual({ zone: 'D', chargedWeightGrams: 1000, freightPaise: 6_500, codChargePaise: 4_000, taxPaise: 2_025, totalPaise: 13_275 });
  });
});

describe('the COD charge', () => {
  it('is asked for with the payment type and amount', async () => {
    // Shaped like the live reply for 110053 → 110001, 0.5 kg surface, COD ₹5,000.
    const { fetchImpl, calls } = stub({
      body: [{ zone: 'A', charged_weight: 500, charge_DL: 30, charge_RTO: 0, charge_DTO: 0, charge_COD: 100, gross_amount: 135.61, total_amount: 160.01 }],
    });
    const q = await provider(fetchImpl).p.quote({
      originPincode: '110053', destinationPincode: '110001', mode: 'SURFACE', weightGrams: 500, kind: 'DELIVERED', payment: 'COD', codAmountPaise: 500_000,
    });
    const params = Object.fromEntries(new URL(calls[0]!.url).searchParams);
    expect(params).toMatchObject({ md: 'S', ss: 'Delivered', pt: 'COD', cod: '5000' });
    expect(q).toEqual({ zone: 'A', chargedWeightGrams: 500, freightPaise: 3_000, codChargePaise: 10_000, taxPaise: 2_440, totalPaise: 16_001 });
  });
});

describe('booking', () => {
  it('sends the documented form (format=json&data=…) with the warehouse name, grams and centimetres', async () => {
    const { fetchImpl, calls } = stub({ body: { success: true, packages: [{ waybill: '1490810000001', status: 'Success', refnum: 'shp_123' }] } });
    const booked = await provider(fetchImpl).p.createShipment(booking());
    expect(booked).toEqual({
      awbNumber: '1490810000001', courierName: 'Delhivery', trackingUrl: '/track?orderNumber=CLW-2026-000777', estimatedFreightPaise: null,
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://staging-express.delhivery.com/api/cmu/create.json');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.body);
    expect(form.get('format')).toBe('json');
    const data = JSON.parse(form.get('data')!) as { shipments: Record<string, unknown>[]; pickup_location: { name: string } };
    expect(data.pickup_location).toEqual({ name: 'CLW-seller1' });
    expect(data.shipments[0]).toMatchObject({
      name: 'Asha Rao', add: '12 MG Road, Flat 4', pin: '411001', city: 'Pune', state: 'Maharashtra', country: 'India', phone: '9000000001',
      order: 'shp_123', payment_mode: 'COD', cod_amount: 865.5, total_amount: 865.5, products_desc: 'Tee x2, Cap x1', hsn_code: '6109,6505',
      quantity: 3, weight: 900, shipment_length: 31, shipment_width: 25, shipment_height: 4, shipping_mode: 'Surface', seller_gst_tin: '27ABCDE1234F1Z5',
    });
  });

  it('prepaid parcels collect nothing', async () => {
    const { fetchImpl, calls } = stub({ body: { success: true, packages: [{ waybill: '1490810000002', status: 'Success' }] } });
    await provider(fetchImpl).p.createShipment(booking({ payment: 'PREPAID', codAmountPaise: 0, mode: 'EXPRESS' }));
    const data = JSON.parse(new URLSearchParams(calls[0]!.body).get('data')!) as { shipments: Record<string, unknown>[] };
    expect(data.shipments[0]).toMatchObject({ payment_mode: 'Prepaid', cod_amount: 0, shipping_mode: 'Express' });
  });

  it('reads a refusal from the package even though Delhivery answers HTTP 200', async () => {
    const { fetchImpl } = stub({
      body: { success: false, rmk: 'An internal Error has occurred', packages: [{ waybill: '', status: 'Fail', remarks: ['Crashing while saving package due to exception \'Pincode not serviceable\''] }] },
    });
    const err = await refusal(provider(fetchImpl).p.createShipment(booking()));
    expect(err.code).toBe('BOOKING_REFUSED');
    expect(err.message).toContain('Pincode not serviceable');
  });

  it('will not book without a registered pickup address, and calls nothing', async () => {
    const { fetchImpl, calls } = stub({ body: {} });
    expect((await refusal(provider(fetchImpl).p.createShipment(booking({ pickup: { warehouseName: null, pincode: '110001' } })))).code).toBe('NO_WAREHOUSE');
    expect(calls).toHaveLength(0);
  });

  it('books a reverse pickup from the customer back to the seller’s warehouse', async () => {
    const { fetchImpl, calls } = stub({ body: { success: true, packages: [{ waybill: '1490810000003', status: 'Success' }] } });
    const r = await provider(fetchImpl).p.createReversePickup({
      reference: 'ret_1', orderNumber: 'CLW-1', customer: booking().consignee, warehouseName: 'CLW-seller1',
      valuePaise: 49_900, weightGrams: 500, lengthMm: null, widthMm: null, heightMm: null, products: [{ title: 'Tee', quantity: 1, hsn: null }],
    });
    expect(r.awbNumber).toBe('1490810000003');
    const data = JSON.parse(new URLSearchParams(calls[0]!.body).get('data')!) as { shipments: Record<string, unknown>[]; pickup_location: { name: string } };
    expect(data.shipments[0]).toMatchObject({ payment_mode: 'Pickup', pin: '411001', total_amount: 499 });
    expect(data.shipments[0]).not.toHaveProperty('shipment_length');
    expect(data.pickup_location.name).toBe('CLW-seller1');
  });
});

describe('warehouses, labels, pickups, cancellation and NDR', () => {
  const warehouse = {
    name: 'CLW-seller1', registeredName: 'Booking Shop Pvt Ltd', phone: '9000000000', email: 'shop@example.com',
    address: { line1: '5 Seller Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    returnAddress: { line1: '5 Seller Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
  };

  it('registers a warehouse with its own return address, and edits it when it exists', async () => {
    const created = stub({ body: { success: true, data: { name: 'CLW-seller1' } } });
    expect(await provider(created.fetchImpl).p.upsertWarehouse(warehouse)).toEqual({ name: 'CLW-seller1', created: true });
    expect(JSON.parse(created.calls[0]!.body!)).toMatchObject({
      name: 'CLW-seller1', registered_name: 'Booking Shop Pvt Ltd', pin: '400001', country: 'India',
      return_address: '5 Seller Road', return_pin: '400001', return_city: 'Mumbai', return_state: 'Maharashtra', return_country: 'India',
    });
    const exists = stub({ body: { success: false, error: ['Client-Warehouse already exists'] } }, { body: { success: true } });
    expect(await provider(exists.fetchImpl).p.upsertWarehouse(warehouse)).toEqual({ name: 'CLW-seller1', created: false });
    expect(exists.calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/backend/clientwarehouse/create/', '/api/backend/clientwarehouse/edit/']);
    const refused = stub({ body: { success: false, error: ['Invalid pincode'] } });
    expect((await refusal(provider(refused.fetchImpl).p.upsertWarehouse(warehouse))).message).toContain('Invalid pincode');
  });

  it('reads the packing slip for the label', async () => {
    const { fetchImpl, calls } = stub({ body: { packages_found: 1, packages: [{ wbn: '1490810000001', sort_code: 'PNQ/KTR', destination: 'Pune_Kothrud_D' }] } });
    expect(await provider(fetchImpl).p.getLabel('1490810000001')).toEqual({
      awbNumber: '1490810000001', barcodeValue: '1490810000001', sortCode: 'PNQ/KTR', destinationHub: 'Pune_Kothrud_D',
    });
    expect(calls[0]!.url).toBe('https://staging-express.delhivery.com/api/p/packing_slip?wbns=1490810000001');
  });

  it('requests a pickup in Indian time', async () => {
    const { fetchImpl, calls } = stub({ body: { pickup_id: 8812, pickup_date: '2026-10-22' } });
    const r = await provider(fetchImpl).p.requestPickup({ warehouseName: 'CLW-seller1', pickupAt: new Date('2026-10-22T05:30:00Z'), expectedPackages: 3 });
    expect(r.pickupRequestId).toBe('8812');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ pickup_location: 'CLW-seller1', pickup_date: '2026-10-22', pickup_time: '11:00:00', expected_package_count: 3 });
    const refused = stub({ body: { pr_exist: true, error: 'Pickup request already exists' } });
    expect((await refusal(provider(refused.fetchImpl).p.requestPickup({ warehouseName: 'CLW-seller1', pickupAt: new Date(), expectedPackages: 1 }))).code).toBe('PICKUP_REFUSED');
  });

  it('cancels, and reports a refusal', async () => {
    const ok = stub({ body: { status: true, remark: 'Shipment has been cancelled' } });
    await provider(ok.fetchImpl).p.cancelShipment('1490810000001');
    expect(JSON.parse(ok.calls[0]!.body!)).toEqual({ waybill: '1490810000001', cancellation: 'true' });
    const no = stub({ body: { status: false, remark: 'Shipment is already delivered' } });
    expect((await refusal(provider(no.fetchImpl).p.cancelShipment('1490810000001'))).message).toContain('already delivered');
  });

  it('sends NDR actions in Delhivery’s words', async () => {
    const { fetchImpl, calls } = stub({ body: { request_id: 'UPL123' } });
    const { p } = provider(fetchImpl);
    expect(await p.ndrAction('1490810000001', { action: 'RE_ATTEMPT' })).toEqual({ requestId: 'UPL123' });
    await p.ndrAction('1490810000001', { action: 'DEFER_DELIVERY', deferTo: new Date('2026-10-24T03:00:00Z') });
    expect(calls.map((c) => JSON.parse(c.body!))).toEqual([
      { data: [{ waybill: '1490810000001', act: 'RE-ATTEMPT' }] },
      { data: [{ waybill: '1490810000001', act: 'DEFER_DLV', action_data: { deferred_date: '2026-10-24' } }] },
    ]);
  });
});

describe('tracking', () => {
  it('reads scans in Indian time and maps the current status', async () => {
    const { fetchImpl, calls } = stub({
      body: {
        ShipmentData: [
          {
            Shipment: {
              AWB: '1490810000001',
              ChargedWeight: 1000,
              Status: { Status: 'RTO', StatusType: 'DL', StatusDateTime: '2026-10-25T16:20:00.000', Instructions: 'RTO delivered to seller' },
              Scans: [
                { ScanDetail: { Scan: 'Manifested', ScanType: 'UD', ScanDateTime: '2026-10-20T10:00:00.000', ScannedLocation: 'Mumbai_Andheri (Maharashtra)', StatusCode: 'X-UCI', Instructions: 'Manifest uploaded' } },
                { ScanDetail: { Scan: 'Pending', ScanType: 'UD', ScanDateTime: '2026-10-22T19:00:00.000', ScannedLocation: 'Pune_Kothrud_D', StatusCode: 'EOD-11', Instructions: 'Consignee unavailable' } },
                { ScanDetail: { Scan: 'In Transit', ScanType: 'RT', ScanDateTime: '2026-10-23T09:00:00', ScannedLocation: 'Pune_Hub', StatusCode: 'RT-101' } },
              ],
            },
          },
        ],
      },
    });
    const [t] = await provider(fetchImpl).p.track(['1490810000001', '1490810000002']);
    expect(calls[0]!.url).toBe('https://staging-express.delhivery.com/api/v1/packages/json/?waybill=1490810000001%2C1490810000002');
    expect(t).toMatchObject({ awbNumber: '1490810000001', status: 'RTO_DELIVERED', statusText: 'RTO delivered to seller', chargedWeightGrams: 1000 });
    expect(t!.scans).toHaveLength(3);
    expect(t!.scans[0]).toEqual({
      at: new Date('2026-10-20T04:30:00.000Z'), statusType: 'UD', status: 'Manifested', code: 'X-UCI', location: 'Mumbai_Andheri (Maharashtra)', instructions: 'Manifest uploaded',
    });
    expect(t!.scans[1]!.code).toBe('EOD-11');
  });

  it('takes at most 30 AWBs a call', async () => {
    const { fetchImpl, calls } = stub({ body: {} });
    expect((await refusal(provider(fetchImpl).p.track(Array.from({ length: 31 }, (_, i) => String(i))))).code).toBe('TOO_MANY_AWBS');
    expect(await provider(fetchImpl).p.track([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('keeps an explicit offset as given', () => {
    expect(delhiveryTime('2026-10-20T10:00:00+05:30').toISOString()).toBe('2026-10-20T04:30:00.000Z');
    expect(delhiveryTime('2026-10-20T04:30:00Z').toISOString()).toBe('2026-10-20T04:30:00.000Z');
  });
});
