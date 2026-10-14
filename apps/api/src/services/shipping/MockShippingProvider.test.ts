import { describe, expect, it } from 'vitest';
import { MockShippingProvider, mockZone } from './MockShippingProvider';
import { isFailedAttempt, shipmentStatusFromScan } from './scanStatus';
import { ShippingProviderError, type CreateShipmentRequest } from './ShippingProvider';

const request = (over: Partial<CreateShipmentRequest> = {}): CreateShipmentRequest => ({
  reference: `ref-${Math.random()}`,
  orderNumber: 'CLW-2026-000001',
  pickup: { warehouseName: 'CLW-seller1', pincode: '110001' },
  consignee: { name: 'Buyer', phone: '9000000000', line1: '1 Street', line2: null, city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
  payment: 'PREPAID',
  codAmountPaise: 0,
  invoiceValuePaise: 49_900,
  mode: 'SURFACE',
  weightGrams: 500,
  lengthMm: null,
  widthMm: null,
  heightMm: null,
  products: [{ title: 'Tee', quantity: 1, hsn: '6109' }],
  sellerGstin: null,
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ShippingProviderError);
  return (err as ShippingProviderError).code;
}

describe('the mock courier', () => {
  it('is Delhivery, and only Delhivery', async () => {
    const mock = new MockShippingProvider();
    expect(mock.courierName).toBe('Delhivery');
    expect((await mock.createShipment(request())).courierName).toBe('Delhivery');
  });

  it('answers serviceability like Delhivery: unserved and prepaid-only test pincodes, a COD cap', async () => {
    const mock = new MockShippingProvider();
    expect(await mock.checkPincode('400001')).toMatchObject({ serviceable: true, cod: true, codLimitPaise: 5_000_000 });
    expect(await mock.checkPincode('999999')).toMatchObject({ serviceable: false, cod: false, pickup: false });
    expect(await mock.checkPincode('888888')).toMatchObject({ serviceable: true, prepaid: true, cod: false });
    expect((await mock.checkPincode('012345')).serviceable).toBe(false);
  });

  it('prices a parcel at the flat test rate, GST included, and adds COD and return legs as Delhivery does', async () => {
    const mock = new MockShippingProvider({ flatParcelPaise: async () => 6_000 });
    expect(mockZone('110001', '110016')).toBe('A');
    expect(mockZone('110001', '400001')).toBe('D');
    expect(mockZone('110001', '781001')).toBe('E');
    const route = { originPincode: '110001', destinationPincode: '110016', mode: 'SURFACE' as const, weightGrams: 700 };
    const prepaid = await mock.quote({ ...route, kind: 'DELIVERED', payment: 'PREPAID' });
    expect(prepaid).toMatchObject({ zone: 'A', chargedWeightGrams: 1000, codChargePaise: 0, totalPaise: 6_000 });
    expect(prepaid.freightPaise + prepaid.taxPaise).toBe(6_000);
    // COD: ₹40 on ₹1,000 (2 % is less), 2 % on ₹5,000; plus 18 % GST.
    const small = await mock.quote({ ...route, kind: 'DELIVERED', payment: 'COD', codAmountPaise: 100_000 });
    expect(small.totalPaise - prepaid.totalPaise).toBe(4_720);
    const large = await mock.quote({ ...route, kind: 'DELIVERED', payment: 'COD', codAmountPaise: 500_000 });
    expect(large.totalPaise - prepaid.totalPaise).toBe(11_800);
    // An RTO quote is both legs, as Delhivery's is; a customer return 1.2×.
    expect((await mock.quote({ ...route, kind: 'RTO', payment: 'PREPAID' })).totalPaise).toBe(12_000);
    expect((await mock.quote({ ...route, kind: 'DTO', payment: 'PREPAID' })).totalPaise).toBe(7_200);
    // Without a rate given, the default test rate.
    expect((await new MockShippingProvider().quote({ ...route, kind: 'DELIVERED', payment: 'PREPAID' })).totalPaise).toBe(6_000);
  });

  it('books once per reference, refuses unserved pincodes and COD it can’t collect', async () => {
    const mock = new MockShippingProvider();
    const r = request();
    const booked = await mock.createShipment(r);
    expect(booked.awbNumber).toMatch(/^AWB\d+$/);
    expect(booked.estimatedFreightPaise).toBeGreaterThan(0);
    expect(await refusal(mock.createShipment(r))).toBe('DUPLICATE_REFERENCE');
    expect(await refusal(mock.createShipment(request({ consignee: { ...r.consignee, pincode: '999999' } })))).toBe('PINCODE_NOT_SERVICEABLE');
    expect(await refusal(mock.createShipment(request({ payment: 'COD', codAmountPaise: 5_000_001 })))).toBe('COD_NOT_AVAILABLE');
    expect(await refusal(mock.createShipment(request({ payment: 'COD', codAmountPaise: 100, consignee: { ...r.consignee, pincode: '888888' } })))).toBe('COD_NOT_AVAILABLE');
    // A refused reference can be booked again once fixed.
    const retry = request();
    await refusal(mock.createShipment({ ...retry, weightGrams: 0 }));
    await expect(mock.createShipment(retry)).resolves.toMatchObject({ courierName: 'Delhivery' });
  });

  it('refuses warehouse names with an underscore, as Delhivery does', async () => {
    const mock = new MockShippingProvider();
    const w = {
      name: 'CLW-abc', registeredName: 'Shop', phone: '9000000000', email: null,
      address: { line1: '1 Road', city: 'Delhi', state: 'Delhi', pincode: '110001' },
      returnAddress: { line1: '1 Road', city: 'Delhi', state: 'Delhi', pincode: '110001' },
    };
    expect(await mock.upsertWarehouse(w)).toEqual({ name: 'CLW-abc', created: true });
    expect(await mock.upsertWarehouse(w)).toEqual({ name: 'CLW-abc', created: false });
    expect(await refusal(mock.upsertWarehouse({ ...w, name: 'CLW_abc' }))).toBe('INVALID_WAREHOUSE_NAME');
  });

  it('tracks a parcel through delivery, and through a failed attempt into RTO', async () => {
    const mock = new MockShippingProvider();
    const a = (await mock.createShipment(request())).awbNumber;
    const b = (await mock.createShipment(request())).awbNumber;
    expect((await mock.track([a]))[0]).toMatchObject({ status: 'CREATED', statusText: 'Manifested' });
    mock.simulate(a, 'PICKED_UP');
    mock.simulate(a, 'OUT_FOR_DELIVERY');
    expect((await mock.track([a]))[0]!.status).toBe('OUT_FOR_DELIVERY');
    mock.simulate(a, 'DELIVERED');
    const done = (await mock.track([a]))[0]!;
    expect(done.status).toBe('DELIVERED');
    expect(done.scans.map((s) => s.statusType)).toEqual(['UD', 'UD', 'UD', 'DL']);
    expect(done.chargedWeightGrams).toBe(500);

    mock.simulate(b, 'PICKED_UP');
    mock.simulate(b, 'DELIVERY_FAILED');
    expect((await mock.track([b]))[0]!.status).toBe('DELIVERY_FAILED');
    await expect(mock.ndrAction(b, { action: 'RE_ATTEMPT' })).resolves.toMatchObject({ requestId: expect.stringMatching(/^MOCK-NDR-/) });
    mock.simulate(b, 'DELIVERY_FAILED');
    expect(await refusal(mock.ndrAction(b, { action: 'DEFER_DELIVERY', deferTo: new Date(Date.now() + 8 * 86_400_000) }))).toBe('NDR_BAD_DATE');
    mock.simulate(b, 'RTO');
    expect((await mock.track([b]))[0]!.status).toBe('RTO_IN_TRANSIT');
    mock.simulate(b, 'RTO_DELIVERED');
    expect((await mock.track([b]))[0]!.status).toBe('RTO_DELIVERED');
    expect(await refusal(mock.ndrAction(b, { action: 'RE_ATTEMPT' }))).toBe('NDR_NOT_ALLOWED');
  });

  it('cancels before pickup; after pickup a cancel sends it back; never once delivered', async () => {
    const mock = new MockShippingProvider();
    const a = (await mock.createShipment(request())).awbNumber;
    await mock.cancelShipment(a);
    expect((await mock.track([a]))[0]!.status).toBe('CANCELLED');
    const b = (await mock.createShipment(request())).awbNumber;
    mock.simulate(b, 'PICKED_UP');
    await mock.cancelShipment(b);
    expect((await mock.track([b]))[0]!.status).toBe('RTO_IN_TRANSIT');
    const c = (await mock.createShipment(request())).awbNumber;
    mock.simulate(c, 'DELIVERED');
    expect(await refusal(mock.cancelShipment(c))).toBe('NOT_CANCELLABLE');
    expect(await refusal(mock.cancelShipment('AWB-NOPE'))).toBe('UNKNOWN_AWB');
  });

  it('labels, pickups, reverse pickups and the 30-AWB tracking limit', async () => {
    const mock = new MockShippingProvider();
    const a = (await mock.createShipment(request())).awbNumber;
    expect(await mock.getLabel(a)).toMatchObject({ awbNumber: a, barcodeValue: a, sortCode: 'MOCK/D/400' });
    const pickup = await mock.requestPickup({ warehouseName: 'CLW-abc', pickupAt: new Date('2026-10-22T11:00:00Z'), expectedPackages: 2 });
    expect(pickup.pickupRequestId).toMatch(/^MOCK-PU-/);
    expect(await refusal(mock.requestPickup({ warehouseName: 'CLW-abc', pickupAt: new Date(), expectedPackages: 0 }))).toBe('INVALID_COUNT');
    const r = request();
    const rev = await mock.createReversePickup({
      reference: 'rev-1', orderNumber: r.orderNumber, customer: r.consignee, warehouseName: 'CLW-abc',
      valuePaise: 49_900, weightGrams: 500, lengthMm: null, widthMm: null, heightMm: null, products: r.products,
    });
    expect((await mock.track([rev.awbNumber]))[0]!.status).toBe('PICKUP_REQUESTED');
    mock.simulate(rev.awbNumber, 'PICKED_UP');
    mock.simulate(rev.awbNumber, 'DELIVERED');
    expect((await mock.track([rev.awbNumber]))[0]!.status).toBe('DELIVERED');
    expect(await refusal(mock.track(Array.from({ length: 31 }, (_, i) => `AWB${i}`)))).toBe('TOO_MANY_AWBS');
  });
});

describe('a Delhivery scan as our shipment status', () => {
  it('maps by type and status, failed attempts by their EOD code, unknown scans as still moving', () => {
    const cases: [string, string, string, string][] = [
      ['UD', 'Manifested', '', 'CREATED'],
      ['UD', 'Not Picked', '', 'CREATED'],
      ['UD', 'In Transit', 'X-PPOM', 'IN_TRANSIT'],
      ['UD', 'Pending', 'EOD-11', 'DELIVERY_FAILED'],
      ['UD', 'Pending', 'X-ILL2F', 'IN_TRANSIT'],
      ['UD', 'Dispatched', '', 'OUT_FOR_DELIVERY'],
      ['DL', 'Delivered', 'EOD-38', 'DELIVERED'],
      ['RT', 'In Transit', '', 'RTO_IN_TRANSIT'],
      ['RT', 'Dispatched', '', 'RTO_IN_TRANSIT'],
      ['DL', 'RTO', '', 'RTO_DELIVERED'],
      ['PP', 'Open', '', 'PICKUP_REQUESTED'],
      ['PU', 'In Transit', '', 'IN_TRANSIT'],
      ['DL', 'DTO', '', 'DELIVERED'],
      ['CN', 'Canceled', '', 'CANCELLED'],
      ['UD', 'Lost', '', 'LOST'],
      ['UD', 'Something New', '', 'IN_TRANSIT'],
    ];
    for (const [statusType, status, code, expected] of cases) {
      expect(shipmentStatusFromScan({ statusType, status, code }), `${statusType}/${status}/${code}`).toBe(expected);
    }
    expect(isFailedAttempt({ statusType: 'DL', status: 'Delivered', code: 'EOD-38' })).toBe(false);
  });
});
