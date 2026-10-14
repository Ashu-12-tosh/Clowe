import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { shippingProvider } from '../services/shipping';
import { postCodFee, postForwardFreight, postRtoFreight } from '../services/shipping/freight';
import { syncShipmentsFromLines } from '../services/shipping/shipments';
import { signAccessToken } from '../utils/jwt';

/**
 * Sellers pay the courier's actual forward freight for each parcel, not a
 * flat fee per line: Delhivery's estimate before they confirm a booking,
 * stored on the parcel, and the final charge posted once, on delivery, at
 * the charged weight. A later re-weigh posts its own adjustment. With the
 * mock courier, the estimate is the admin's flat test rate.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;
let sellerId: string;
let productId: string;
let variantId: string;
let buyerId: string;
let seq = 0;
const orders: string[] = [];
const TEST_RATE = 7_000; // the mock's flat estimate for this file

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; error?: { message: string } } };
}

async function paidOrder(lines = 1, cod = false) {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-88${String(seq).padStart(4, '0')}`, status: 'CONFIRMED',
      subtotalPaise: 50_000 * lines, shippingPaise: 0, totalPaise: 50_000 * lines, paymentMethod: cod ? 'COD' : 'UPI',
      shipName: 'Freight Buyer', shipPhone: '9197700002', shipLine1: '1 Test Street', shipCity: 'Mumbai', shipState: 'Maharashtra', shipPincode: '400001',
      payment: { create: { provider: 'mock', amountPaise: 50_000 * lines, status: cod ? 'CREATED' : 'PAID' } },
      items: {
        create: Array.from({ length: lines }, (_, i) => ({
          productId, variantId, sellerId, title: `Freight Tee ${i + 1}`, size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'CONFIRMED' as const,
        })),
      },
    },
    include: { items: true },
  });
  orders.push(order.id);
  await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId, fileRef: 'asset:test' } });
  return { orderId: order.id, ids: order.items.map((i) => i.id) };
}

const freightRows = (orderId: string) =>
  prisma.sellerLedgerEntry.findMany({ where: { orderId, type: { in: ['FORWARD_FREIGHT', 'FREIGHT_ADJUSTMENT', 'DELIVERY_FEE'] } }, orderBy: { createdAt: 'asc' } });
const courierRows = (orderId: string) =>
  prisma.sellerLedgerEntry.findMany({
    where: { orderId, type: { in: ['FORWARD_FREIGHT', 'FREIGHT_ADJUSTMENT', 'COD_FEE', 'RTO_FREIGHT'] } },
    orderBy: { createdAt: 'asc' },
  });
/** Delhivery's COD fee on ₹500: 2 % is ₹10, so the ₹40 minimum, plus 18 % GST. */
const COD_FEE_500 = 4_720;

async function shipAndDeliver(ids: string[]) {
  expect((await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'ship' })).json.data).toMatchObject({ updated: ids.length });
  expect((await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'deliver' })).json.data).toMatchObject({ updated: ids.length });
}

beforeAll(async () => {
  await setSetting('deliveryFeePaise', TEST_RATE);
  const user = await prisma.user.create({ data: { phone: '9197700001', name: 'Freight Seller', role: Role.SELLER, referralCode: 'FRT-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName: 'Freight Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
        addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  buyerId = (await prisma.user.create({ data: { phone: '9197700002', name: 'Freight Buyer', referralCode: 'FRT-B' } })).id;
  const category = await prisma.category.create({ data: { name: 'Freight Tees', slug: 'freight-tees', isActive: true } });
  // 300 g, but a 40 × 30 × 10 cm box: 2.4 kg volumetric.
  productId = (
    await prisma.product.create({
      data: {
        sellerId, categoryId: category.id, title: 'Freight Tee', slug: 'freight-tee', description: 'For freight tests.', basePricePaise: 50_000,
        status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300, lengthMm: 400, widthMm: 300, heightMm: 100,
      },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-FRT', pricePaise: 50_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await setSetting('deliveryFeePaise', DEFAULT_SETTINGS.deliveryFeePaise);
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.sellerLedgerEntry.deleteMany({ where: { sellerId } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('before booking', () => {
  it('shows each parcel’s estimate, priced on the greater of actual and volumetric weight', async () => {
    const { ids } = await paidOrder();
    const quote = vi.spyOn(shippingProvider, 'quote');
    const r = await call('GET', `/api/seller/orders/booking-quote?ids=${ids.join(',')}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data).toMatchObject({
      provider: 'mock',
      totalPaise: TEST_RATE,
      skipped: [],
      parcels: [{ itemIds: ids, payment: 'PREPAID', chargeableGrams: 2_400, forwardFreightPaise: TEST_RATE, totalPaise: TEST_RATE, error: null }],
    });
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({ originPincode: '110053', destinationPincode: '400001', mode: 'SURFACE', weightGrams: 2_400, kind: 'DELIVERED', payment: 'PREPAID' }),
    );
    quote.mockRestore();
  });

  it('says why a line can’t be quoted, and books nothing', async () => {
    const { ids } = await paidOrder();
    await call('PATCH', `/api/seller/orders/${ids[0]}/status`, { action: 'assign' });
    const r = await call('GET', `/api/seller/orders/booking-quote?ids=${ids[0]},nope`);
    expect(r.json.data).toMatchObject({ parcels: [], totalPaise: 0 });
    expect((r.json.data.skipped as { reason: string }[]).map((s) => s.reason)).toEqual(['Not one of your items', expect.stringMatching(/^Already booked/)]);
  });

  it('stores the estimate on the parcel when it is booked, Surface', async () => {
    const { ids } = await paidOrder();
    await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'assign' });
    const s = await prisma.shipment.findFirstOrThrow({ where: { items: { some: { id: ids[0] } } } });
    expect(s).toMatchObject({ estimatedFreightPaise: TEST_RATE, mode: 'SURFACE', finalFreightPaise: null });
  });
});

describe('on delivery', () => {
  it('posts the parcel’s forward freight once — not a fee per line', async () => {
    const { orderId, ids } = await paidOrder(2);
    await shipAndDeliver(ids);
    const rows = await freightRows(orderId);
    expect(rows.map((r) => [r.type, r.amountPaise, r.orderItemId])).toEqual([['FORWARD_FREIGHT', -TEST_RATE, null]]);
    const s = await prisma.shipment.findFirstOrThrow({ where: { orderId } });
    // Two 300 g tees in one box whose size is confirmed later: 600 g charged.
    expect(s).toMatchObject({ finalFreightPaise: TEST_RATE, freightWeightGrams: 600 });
    // Replays post nothing more.
    expect(await postForwardFreight(s.id)).toBe('UNCHANGED');
    expect(await freightRows(orderId)).toHaveLength(1);
    // The sale and its other deductions are still per line, as before.
    expect(await prisma.sellerLedgerEntry.count({ where: { orderId, type: 'SALE_EARNING' } })).toBe(2);
  });

  it('posts a separate adjustment when the charged weight changes, never editing the first entry', async () => {
    const { orderId, ids } = await paidOrder();
    await shipAndDeliver(ids);
    const s = await prisma.shipment.findFirstOrThrow({ where: { orderId } });
    const first = (await freightRows(orderId))[0]!;
    // Delhivery re-weighs the parcel at 3 kg, and prices it at ₹95.
    await setSetting('deliveryFeePaise', 9_500);
    await prisma.shipment.update({ where: { id: s.id }, data: { chargedWeightGrams: 3_000 } });
    expect(await postForwardFreight(s.id)).toBe('ADJUSTED');
    expect(await postForwardFreight(s.id)).toBe('UNCHANGED');
    const rows = await freightRows(orderId);
    expect(rows.map((r) => [r.type, r.amountPaise])).toEqual([
      ['FORWARD_FREIGHT', -TEST_RATE],
      ['FREIGHT_ADJUSTMENT', -2_500],
    ]);
    expect(rows[0]).toMatchObject({ id: first.id, amountPaise: first.amountPaise });
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ finalFreightPaise: 9_500, freightWeightGrams: 3_000 });
    await setSetting('deliveryFeePaise', TEST_RATE);
  });

  it('when the charges API is down, delivers anyway and posts the freight before the next payout figures', async () => {
    const { orderId, ids } = await paidOrder();
    const down = vi.spyOn(shippingProvider, 'quote').mockRejectedValue(new Error('Delhivery did not answer in time'));
    await shipAndDeliver(ids);
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: ids[0] } })).toMatchObject({ status: 'DELIVERED' });
    expect(await freightRows(orderId)).toHaveLength(0);
    down.mockRestore();
    expect((await call('GET', '/api/seller/payouts/overview')).status).toBe(200);
    expect((await freightRows(orderId)).map((r) => r.amountPaise)).toEqual([-TEST_RATE]);
  });

  it('takes the freight off what can be paid out straight away', async () => {
    const before = (await call('GET', '/api/seller/payouts/overview')).json.data.kpis as { payablePaise: number };
    const { orderId, ids } = await paidOrder();
    await shipAndDeliver(ids);
    const after = (await call('GET', '/api/seller/payouts/overview')).json.data.kpis as { payablePaise: number };
    // The sale is still in the return window; the freight is not held.
    expect(after.payablePaise).toBe(Math.max(0, before.payablePaise - TEST_RATE));
    expect(await freightRows(orderId)).toHaveLength(1);
  });
});

describe('the COD fee', () => {
  it('is in the estimate before a COD parcel is booked, and stored when it is', async () => {
    const { ids } = await paidOrder(1, true);
    const r = await call('GET', `/api/seller/orders/booking-quote?ids=${ids.join(',')}`);
    expect(r.json.data).toMatchObject({
      totalPaise: TEST_RATE + COD_FEE_500,
      parcels: [{ payment: 'COD', codAmountPaise: 50_000, forwardFreightPaise: TEST_RATE, codFeePaise: COD_FEE_500, totalPaise: TEST_RATE + COD_FEE_500 }],
    });
    await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'assign' });
    const s = await prisma.shipment.findFirstOrThrow({ where: { items: { some: { id: ids[0] } } } });
    expect(s).toMatchObject({ estimatedFreightPaise: TEST_RATE, estimatedCodFeePaise: COD_FEE_500, codFeePaise: null });
  });

  it('is posted as its own entry when a COD parcel is delivered, once, and read from the charges API', async () => {
    const quote = vi.spyOn(shippingProvider, 'quote');
    const { orderId, ids } = await paidOrder(1, true);
    await shipAndDeliver(ids);
    expect((await courierRows(orderId)).map((r) => [r.type, r.amountPaise])).toEqual([
      ['FORWARD_FREIGHT', -TEST_RATE],
      ['COD_FEE', -COD_FEE_500],
    ]);
    // Priced by asking for the parcel as COD, with the amount collected.
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ payment: 'COD', codAmountPaise: 50_000, kind: 'DELIVERED' }));
    quote.mockRestore();
    const s = await prisma.shipment.findFirstOrThrow({ where: { orderId } });
    expect(s.codFeePaise).toBe(COD_FEE_500);
    expect(await postCodFee(s.id)).toBe('UNCHANGED');
    expect(await courierRows(orderId)).toHaveLength(2);
  });

  it('is 2 % above ₹2,000, and nothing on a prepaid parcel', async () => {
    const big = await paidOrder(5, true); // ₹2,500 collected: 2 % is ₹50, plus GST
    await shipAndDeliver(big.ids);
    expect((await courierRows(big.orderId)).find((r) => r.type === 'COD_FEE')?.amountPaise).toBe(-5_900);
    const prepaid = await paidOrder();
    await shipAndDeliver(prepaid.ids);
    expect((await courierRows(prepaid.orderId)).map((r) => r.type)).toEqual(['FORWARD_FREIGHT']);
  });
});

describe('a parcel that comes back undelivered (RTO)', () => {
  /** Shipped, then brought back to the seller: what tracking will record. */
  async function cameBack(cod: boolean) {
    const o = await paidOrder(1, cod);
    expect((await call('POST', '/api/seller/orders/bulk', { itemIds: o.ids, action: 'ship' })).json.data).toMatchObject({ updated: 1 });
    await prisma.orderItem.updateMany({ where: { id: { in: o.ids } }, data: { status: 'RTO_DELIVERED' } });
    const s = await prisma.shipment.findFirstOrThrow({ where: { orderId: o.orderId } });
    await syncShipmentsFromLines([s.id]);
    return { ...o, shipmentId: s.id };
  }

  it('charges the trip out and the trip back, each its own entry at Delhivery’s charge, and no COD fee', async () => {
    const { orderId, shipmentId } = await cameBack(true);
    // The mock's RTO quote is both legs (₹70 + ₹70), as Delhivery's is: the return is ₹70.
    expect((await courierRows(orderId)).map((r) => [r.type, r.amountPaise])).toEqual([
      ['FORWARD_FREIGHT', -TEST_RATE],
      ['RTO_FREIGHT', -TEST_RATE],
    ]);
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).toMatchObject({
      status: 'RTO_DELIVERED',
      finalFreightPaise: TEST_RATE,
      rtoFreightPaise: TEST_RATE,
      codFeePaise: null,
    });
    expect(await postRtoFreight(shipmentId)).toBe('UNCHANGED');
    expect(await postCodFee(shipmentId)).toBe('NOT_DELIVERED');
    expect(await courierRows(orderId)).toHaveLength(2);
    // Nothing was sold: no sale is posted for a line that came back.
    expect(await prisma.sellerLedgerEntry.count({ where: { orderId, type: 'SALE_EARNING' } })).toBe(0);
  });

  it('is caught up before the payout figures if the charges API was down', async () => {
    const down = vi.spyOn(shippingProvider, 'quote').mockRejectedValue(new Error('Delhivery did not answer in time'));
    const { orderId } = await cameBack(false);
    expect(await courierRows(orderId)).toHaveLength(0);
    down.mockRestore();
    expect((await call('GET', '/api/seller/payouts/overview')).status).toBe(200);
    expect((await courierRows(orderId)).map((r) => r.type)).toEqual(['FORWARD_FREIGHT', 'RTO_FREIGHT']);
  });
});
