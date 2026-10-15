import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { env } from '../env';
import { shippingProvider } from '../services/shipping';
import type { MockShippingProvider } from '../services/shipping/MockShippingProvider';
import { applyTracking, pollOpenShipments } from '../services/shipping/tracking';
import { signAccessToken } from '../utils/jwt';

/**
 * Delhivery's scans, applied — polled, pushed or refreshed by an admin, the
 * same way: stored once; the parcel only moves forward and its lines with
 * it; the pickup scan ships them at the scan's time, the delivery scan
 * delivers them and earns the sale, RTO scans send them back; buyers see the
 * scans. Uses the mock courier with Delhivery's behaviour switched on (a
 * pickup waits for its scan) and its simulate() to play the scans.
 */

const prisma = new PrismaClient();
const mock = shippingProvider as MockShippingProvider;
let server: Server;
let base: string;
let token: string;
let adminToken: string;
let buyerToken: string;
let sellerId: string;
let productId: string;
let variantId: string;
let buyerId: string;
let seq = 0;
const orders: string[] = [];

async function call(method: string, path: string, body?: unknown, auth = token, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; error?: { message: string } } };
}

/** A paid order shipped to Delhivery: booked, pickup requested, waiting for the pickup scan. */
async function awaitingPickup(cod = false) {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-44${String(seq).padStart(4, '0')}`, status: 'CONFIRMED', subtotalPaise: 50_000, shippingPaise: 0, totalPaise: 50_000,
      paymentMethod: cod ? 'COD' : 'UPI', shipName: 'Track Buyer', shipPhone: '9194400002', shipLine1: '1 Test Street', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
      payment: { create: { provider: 'mock', amountPaise: 50_000, status: cod ? 'CREATED' : 'PAID' } },
      items: { create: [{ productId, variantId, sellerId, title: 'Track Tee', size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'CONFIRMED' }] },
    },
    include: { items: true },
  });
  orders.push(order.id);
  await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId, fileRef: 'asset:test' } });
  const itemId = order.items[0]!.id;
  const r = await call('PATCH', `/api/seller/orders/${itemId}/status`, { action: 'ship' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
  return { orderId: order.id, itemId, shipmentId: shipment.id, awb: shipment.awbNumber! };
}

const line = (id: string) => prisma.orderItem.findUniqueOrThrow({ where: { id } });
const parcel = (id: string) => prisma.shipment.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  // Delhivery's behaviour: a pickup waits for the courier's scan.
  Object.defineProperty(shippingProvider, 'name', { value: 'delhivery', configurable: true, writable: true });
  const user = await prisma.user.create({ data: { phone: '9194400001', name: 'Track Seller', role: Role.SELLER, referralCode: 'TRK-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName: 'Scan Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
        addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  const admin = await prisma.user.create({ data: { phone: '9194400003', name: 'Track Admin', role: Role.ADMIN, referralCode: 'TRK-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const buyer = await prisma.user.create({ data: { phone: '9194400002', name: 'Track Buyer', referralCode: 'TRK-B' } });
  buyerId = buyer.id;
  buyerToken = signAccessToken({ sub: buyer.id, role: 'CUSTOMER' });
  const category = await prisma.category.create({ data: { name: 'Track Tees', slug: 'track-tees', isActive: true } });
  productId = (
    await prisma.product.create({
      data: { sellerId, categoryId: category.id, title: 'Track Tee', slug: 'track-tee', description: 'For tracking tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300 },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-TRK', pricePaise: 50_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  Object.defineProperty(shippingProvider, 'name', { value: 'mock', configurable: true, writable: true });
  vi.restoreAllMocks();
  // RTO refunds point at their order.
  await prisma.refund.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('scans move the parcel and its lines forward', () => {
  it('ships the line at the pickup scan’s time, delivers it at the delivery scan, and earns the sale', async () => {
    const p = await awaitingPickup();
    expect((await line(p.itemId)).status).toBe('CONFIRMED');
    const pickedUp = new Date('2026-10-22T06:00:00Z');
    mock.simulate(p.awb, 'PICKED_UP', pickedUp);
    await pollOpenShipments();
    expect(await line(p.itemId)).toMatchObject({ status: 'SHIPPED', shippedAt: pickedUp });
    expect(await parcel(p.shipmentId)).toMatchObject({ status: 'IN_TRANSIT', pickedUpAt: pickedUp });

    mock.simulate(p.awb, 'OUT_FOR_DELIVERY');
    const delivered = new Date('2026-10-24T09:00:00Z');
    mock.simulate(p.awb, 'DELIVERED', delivered);
    await pollOpenShipments();
    expect(await line(p.itemId)).toMatchObject({ status: 'DELIVERED', deliveredAt: delivered });
    expect(await parcel(p.shipmentId)).toMatchObject({ status: 'DELIVERED', deliveredAt: delivered });
    expect(await prisma.sellerLedgerEntry.count({ where: { orderItemId: p.itemId, type: 'SALE_EARNING' } })).toBe(1);
    expect(await prisma.sellerLedgerEntry.count({ where: { orderId: p.orderId, type: 'FORWARD_FREIGHT' } })).toBe(1);
    // Every scan stored, once.
    const events = await prisma.shipmentEvent.count({ where: { shipmentId: p.shipmentId } });
    await pollOpenShipments();
    const [result] = await mock.track([p.awb]);
    await applyTracking(result!, 'ADMIN');
    expect(await prisma.shipmentEvent.count({ where: { shipmentId: p.shipmentId } })).toBe(events);
    expect(events).toBe(4); // manifested, picked up, out for delivery, delivered
  });

  it('never moves a parcel back, but follows it out for delivery, through a failed attempt and on again', async () => {
    const p = await awaitingPickup();
    mock.simulate(p.awb, 'PICKED_UP');
    mock.simulate(p.awb, 'OUT_FOR_DELIVERY');
    mock.simulate(p.awb, 'DELIVERY_FAILED');
    await pollOpenShipments();
    expect((await parcel(p.shipmentId)).status).toBe('DELIVERY_FAILED');
    // A stale "manifested" push changes nothing.
    await applyTracking({ awbNumber: p.awb, status: 'CREATED', statusText: 'Manifested', chargedWeightGrams: null, scans: [] }, 'WEBHOOK');
    expect((await parcel(p.shipmentId)).status).toBe('DELIVERY_FAILED');
    mock.simulate(p.awb, 'OUT_FOR_DELIVERY');
    await pollOpenShipments();
    expect((await parcel(p.shipmentId)).status).toBe('OUT_FOR_DELIVERY');
  });

  it('sends the lines back on RTO scans, and charges the RTO once it is back', async () => {
    const p = await awaitingPickup(true);
    mock.simulate(p.awb, 'PICKED_UP');
    mock.simulate(p.awb, 'RTO');
    await pollOpenShipments();
    expect((await line(p.itemId)).status).toBe('RTO_IN_TRANSIT');
    expect((await parcel(p.shipmentId)).status).toBe('RTO_IN_TRANSIT');
    mock.simulate(p.awb, 'RTO_DELIVERED');
    await pollOpenShipments();
    expect((await line(p.itemId)).status).toBe('RTO_DELIVERED');
    expect((await parcel(p.shipmentId)).status).toBe('RTO_DELIVERED');
    const types = (await prisma.sellerLedgerEntry.findMany({ where: { orderId: p.orderId }, select: { type: true } })).map((e) => e.type).sort();
    expect(types).toEqual(['FORWARD_FREIGHT', 'RTO_FREIGHT']);
  });
});

describe('the webhook', () => {
  const push = (body: unknown, secret?: string) =>
    fetch(`${base}/api/webhooks/delhivery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(body),
    });

  it('is off until a token is configured, and refuses a wrong one', async () => {
    const saved = env.DELHIVERY_WEBHOOK_TOKEN;
    env.DELHIVERY_WEBHOOK_TOKEN = undefined;
    expect((await push({})).status).toBe(503);
    env.DELHIVERY_WEBHOOK_TOKEN = 'hook-secret-123';
    expect((await push({}, 'wrong')).status).toBe(401);
    expect((await push({})).status).toBe(401);
    env.DELHIVERY_WEBHOOK_TOKEN = saved;
  });

  it('applies a pushed scan (status only, no history), and ignores AWBs that aren’t ours', async () => {
    const saved = env.DELHIVERY_WEBHOOK_TOKEN;
    env.DELHIVERY_WEBHOOK_TOKEN = 'hook-secret-123';
    try {
      const p = await awaitingPickup();
      const scan = (awb: string) => ({
        Shipment: { AWB: awb, Status: { Status: 'In Transit', StatusType: 'UD', StatusDateTime: '2026-10-22T11:30:00.000', StatusLocation: 'Delhi_Shahdara (Delhi)', StatusCode: 'X-PPOM' } },
      });
      const res = await push([scan(p.awb), scan('NOT-OURS-1')], 'hook-secret-123');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown }).data).toEqual({ received: 2, applied: 1 });
      expect(await line(p.itemId)).toMatchObject({ status: 'SHIPPED', shippedAt: new Date('2026-10-22T06:00:00.000Z') });
      const ev = await prisma.shipmentEvent.findFirstOrThrow({ where: { shipmentId: p.shipmentId, source: 'WEBHOOK' } });
      expect(ev).toMatchObject({ status: 'In Transit', location: 'Delhi_Shahdara (Delhi)' });
    } finally {
      env.DELHIVERY_WEBHOOK_TOKEN = saved;
    }
  });
});

describe('who sees the scans', () => {
  it('shows buyers the scans on public tracking and their order page, never the AWB in public', async () => {
    const p = await awaitingPickup();
    mock.simulate(p.awb, 'PICKED_UP');
    await pollOpenShipments();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: p.orderId } });
    const pub = await fetch(`${base}/api/track?orderNumber=${order.orderNumber}&phone=9194400002`);
    const body = (await pub.json()) as { data: { items: { scans: { status: string }[] }[] } };
    expect(body.data.items[0]!.scans.map((s) => s.status)).toEqual(['In Transit', 'Manifested']);
    expect(JSON.stringify(body)).not.toContain(p.awb);
    const mine = await call('GET', `/api/orders/${p.orderId}`, undefined, buyerToken);
    expect((mine.json.data.items as { scans: unknown[] }[])[0]!.scans).toHaveLength(2);
  });

  it('lets an admin refresh one parcel now', async () => {
    const p = await awaitingPickup();
    mock.simulate(p.awb, 'PICKED_UP');
    const r = await call('POST', `/api/admin/orders/shipments/${p.shipmentId}/refresh`, undefined, adminToken);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data).toMatchObject({ known: true, status: 'IN_TRANSIT' });
    expect((await line(p.itemId)).status).toBe('SHIPPED');
  });
});

describe('when delivery goes wrong', () => {
  it('tells the seller and buyer about a failed attempt, and lets the seller ask Delhivery to try again', async () => {
    const p = await awaitingPickup();
    mock.simulate(p.awb, 'PICKED_UP');
    mock.simulate(p.awb, 'DELIVERY_FAILED');
    await pollOpenShipments();
    expect(await prisma.notification.count({ where: { type: { in: ['SELLER_NDR', 'ORDER_NDR'] }, linkHref: { contains: p.orderId } } })).toBe(2);
    // Not too far ahead.
    const far = new Date(Date.now() + 9 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    expect((await call('POST', `/api/seller/orders/parcels/${p.shipmentId}/ndr`, { action: 'DEFER_DELIVERY', deferTo: far })).status).toBe(400);
    const r = await call('POST', `/api/seller/orders/parcels/${p.shipmentId}/ndr`, { action: 'RE_ATTEMPT' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.requestId).toMatch(/^MOCK-NDR-/);
    expect(await parcel(p.shipmentId)).toMatchObject({ ndrAction: 'RE_ATTEMPT' });
    const detail = await call('GET', `/api/seller/orders/${p.orderId}`);
    expect((detail.json.data.parcels as unknown[])[0]).toMatchObject({ status: 'DELIVERY_FAILED', ndrAction: 'RE_ATTEMPT' });
  });

  it('refuses an NDR action on a parcel whose delivery didn’t fail', async () => {
    const p = await awaitingPickup();
    const r = await call('POST', `/api/seller/orders/parcels/${p.shipmentId}/ndr`, { action: 'RE_ATTEMPT' });
    expect(r.status).toBe(400);
  });

  it('when a prepaid parcel starts back: refunds the buyer, counts it once, and tells both', async () => {
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })).rtoCount;
    const p = await awaitingPickup();
    mock.simulate(p.awb, 'PICKED_UP');
    mock.simulate(p.awb, 'RTO');
    await pollOpenShipments();
    await pollOpenShipments();
    const [again] = await mock.track([p.awb]);
    await applyTracking(again!, 'WEBHOOK');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })).rtoCount).toBe(before + 1);
    const refunds = await prisma.refund.findMany({ where: { orderId: p.orderId } });
    expect(refunds.map((r) => r.amountPaise)).toEqual([50_000]);
    expect(await prisma.notification.count({ where: { type: { in: ['ORDER_RTO', 'SELLER_RTO'] }, linkHref: { contains: p.orderId } } })).toBe(2);
    // Sellers and admins see the count; it blocks nothing.
    expect((await call('GET', `/api/seller/orders/${p.orderId}`)).json.data.buyerRtoCount).toBe(before + 1);
    expect(((await call('GET', `/api/admin/orders/${p.orderId}`, undefined, adminToken)).json.data.customer as { rtoCount: number }).rtoCount).toBe(before + 1);
  });

  it('refunds nothing on a COD parcel that comes back', async () => {
    const p = await awaitingPickup(true);
    mock.simulate(p.awb, 'PICKED_UP');
    mock.simulate(p.awb, 'RTO');
    await pollOpenShipments();
    expect(await prisma.refund.count({ where: { orderId: p.orderId } })).toBe(0);
  });

  it('puts stock back when the seller finds it in good condition, and tells an admin when it came back damaged', async () => {
    const stock = async () => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    const good = await awaitingPickup();
    mock.simulate(good.awb, 'PICKED_UP');
    mock.simulate(good.awb, 'RTO');
    mock.simulate(good.awb, 'RTO_DELIVERED');
    await pollOpenShipments();
    expect(await prisma.notification.count({ where: { type: 'SELLER_RTO_BACK', linkHref: { contains: good.orderId } } })).toBe(1);
    const s0 = await stock();
    expect((await call('POST', `/api/seller/orders/parcels/${good.shipmentId}/rto-received`, { condition: 'GOOD' })).status).toBe(200);
    expect(await stock()).toBe(s0 + 1);
    expect((await call('POST', `/api/seller/orders/parcels/${good.shipmentId}/rto-received`, { condition: 'GOOD' })).status).toBe(400);
    expect(await stock()).toBe(s0 + 1);

    const bad = await awaitingPickup();
    mock.simulate(bad.awb, 'PICKED_UP');
    mock.simulate(bad.awb, 'RTO');
    mock.simulate(bad.awb, 'RTO_DELIVERED');
    await pollOpenShipments();
    const s1 = await stock();
    expect((await call('POST', `/api/seller/orders/parcels/${bad.shipmentId}/rto-received`, { condition: 'DAMAGED' })).status).toBe(200);
    expect(await stock()).toBe(s1);
    expect(await parcel(bad.shipmentId)).toMatchObject({ rtoReceivedCondition: 'DAMAGED' });
    expect(await prisma.notification.count({ where: { type: 'RTO_DAMAGED', body: { contains: bad.awb } } })).toBeGreaterThan(0);
  });

  it('lets an admin ask Delhivery to try again too', async () => {
    const p = await awaitingPickup();
    mock.simulate(p.awb, 'PICKED_UP');
    mock.simulate(p.awb, 'DELIVERY_FAILED');
    await pollOpenShipments();
    const r = await call('POST', `/api/admin/orders/shipments/${p.shipmentId}/ndr`, { action: 'RE_ATTEMPT' }, adminToken);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });
});

describe('a parcel cancelled after pickup', () => {
  it('comes back as RTO without a second refund or an RTO on the buyer, and its courier charges are posted', async () => {
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })).rtoCount;
    const p = await awaitingPickup();
    mock.simulate(p.awb, 'PICKED_UP');
    await pollOpenShipments();
    expect((await line(p.itemId)).status).toBe('SHIPPED');
    const cancel = await call('POST', `/api/admin/orders/${p.orderId}/cancel`, { reason: 'Buyer called to cancel' }, adminToken);
    expect(cancel.status, JSON.stringify(cancel.json)).toBe(200);
    // Delhivery turns a cancelled, picked-up parcel round.
    await pollOpenShipments();
    expect((await parcel(p.shipmentId)).status).toBe('RTO_IN_TRANSIT');
    mock.simulate(p.awb, 'RTO_DELIVERED');
    await pollOpenShipments();
    const back = await parcel(p.shipmentId);
    expect(back.status).toBe('RTO_DELIVERED');
    expect(back.rtoDeliveredAt).not.toBeNull();
    expect((await line(p.itemId)).status).toBe('CANCELLED');
    expect((await prisma.refund.findMany({ where: { orderId: p.orderId } })).map((r) => r.amountPaise)).toEqual([50_000]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })).rtoCount).toBe(before);
    const types = (await prisma.sellerLedgerEntry.findMany({ where: { orderId: p.orderId }, select: { type: true } })).map((e) => e.type).sort();
    expect(types).toEqual(['FORWARD_FREIGHT', 'RTO_FREIGHT']);
  });
});
