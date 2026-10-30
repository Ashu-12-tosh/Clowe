import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import type { ParcelTracking } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { EMAIL_NOTIFICATIONS } from '../services/email';
import { orderSmsCalls } from '../services/messaging/orderSms';
import { shippingProvider } from '../services/shipping';
import { parseDelhiveryShipment } from '../services/shipping/DelhiveryShippingProvider';
import { applyTracking } from '../services/shipping/tracking';
import { seedFixture } from '../test/fixture';
import { signAccessToken, signTrackToken } from '../utils/jwt';

/**
 * Track Order and the tracking bar.
 *
 * - Track Order shows an order only to someone who has the code sent to the
 *   phone or (confirmed) email on it, or to the signed-in buyer; the old
 *   order-number-and-phone lookup is gone.
 * - What it shows: each parcel's bar, Delhivery's scans in plain words, the
 *   AWB and "Delhivery" — never the street, a phone, an email or the seller's
 *   address.
 * - Delhivery's scans, pushed as Delhivery shapes them, move the bar and
 *   headline: picked up, out for delivery, a failed attempt, delivered; the
 *   buyer is emailed at out for delivery, a failed attempt and RTO.
 * - "Refresh" asks Delhivery about an AWB at most once per 10 minutes.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let buyerToken: string;
let otherToken: string;
let sellerToken: string;
let adminToken: string;
let sellerId: string;
let productId: string;
let variantId: string;
let buyerId: string;
const PHONE = '9193000001';
const SHIP_PHONE = '9193000004';
const EMAIL = 'track.buyer@example.com';
let seq = 0;
const orders: string[] = [];

async function call(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { data: Record<string, unknown> & { parcels?: ParcelTracking[]; tracking?: ParcelTracking[] }; error?: { code: string; message: string } } };
}

/** A paid order with one line booked with the courier (AWB issued, waiting for pickup). */
async function bookedOrder() {
  seq += 1;
  const awb = `TRKAWB${Date.now()}${seq}`;
  const order = await prisma.order.create({
    data: {
      orderNumber: `CLW-2026-43${String(seq).padStart(4, '0')}`, userId: buyerId, shipName: 'Track Buyer', shipPhone: SHIP_PHONE, shipLine1: '12 Hidden Street',
      shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001', status: 'PACKED', subtotalPaise: 100_000, totalPaise: 100_000, paymentMethod: 'UPI',
      payment: { create: { provider: 'mock', amountPaise: 100_000, status: 'PAID' } },
      items: {
        create: { productId, variantId, sellerId, title: 'Tracked Kettle', size: '', color: '', pricePaise: 100_000, quantity: 1, status: 'PACKED', packedAt: new Date(), courierName: 'Delhivery', awbNumber: awb },
      },
    },
    include: { items: true },
  });
  orders.push(order.id);
  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id, sellerId, provider: shippingProvider.name, environment: 'mock', awbNumber: awb, paymentType: 'PREPAID', weightGrams: 500,
      status: 'PICKUP_REQUESTED', pickupRequestedAt: new Date(Date.now() - 3_600_000),
    },
  });
  await prisma.orderItem.update({ where: { id: order.items[0]!.id }, data: { shipmentId: shipment.id } });
  return { orderId: order.id, orderNumber: order.orderNumber, itemId: order.items[0]!.id, shipmentId: shipment.id, awb };
}

/** One scan, pushed as Delhivery shapes it (as the webhook and the poll receive it). */
async function scan(awb: string, Status: string, StatusType: string, StatusCode: string, at: Date, Instructions = '', ScannedLocation = 'Pune_Bhosari_H (Maharashtra)') {
  const result = parseDelhiveryShipment({
    AWB: awb,
    Status: { Status, StatusType, StatusCode, StatusDateTime: at.toISOString(), Instructions },
    Scans: [{ ScanDetail: { Scan: Status, ScanType: StatusType, StatusCode, ScanDateTime: at.toISOString(), ScannedLocation, Instructions } }],
  })!;
  return applyTracking(result, 'WEBHOOK');
}

const bar = async (orderId: string) => (await call('GET', `/api/orders/${orderId}`, { token: buyerToken })).json.data.tracking![0]!;
const states = (p: ParcelTracking) => p.steps.map((s) => s.state).join(' ');

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
  const sellerUser = await prisma.user.create({ data: { phone: '9193000002', name: 'Track Seller', role: Role.SELLER, referralCode: 'TRACK-S' } });
  sellerToken = signAccessToken({ sub: sellerUser.id, role: 'SELLER' });
  const seller = await prisma.sellerProfile.create({
    data: { userId: sellerUser.id, shopName: 'Track Shop', status: SellerStatus.APPROVED, addressLine1: '5 Seller Secret Road', city: 'Delhi', state: 'Delhi', pincode: '110053' },
  });
  sellerId = seller.id;
  const admin = await prisma.user.create({ data: { phone: '9193000003', name: 'Track Admin', role: Role.ADMIN, referralCode: 'TRACK-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const product = await prisma.product.create({
    data: { sellerId, categoryId: category.id, title: 'Tracked Kettle', slug: 'tracked-kettle', description: 'Tracking test.', basePricePaise: 100_000, status: ProductStatus.APPROVED },
  });
  productId = product.id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, sku: 'TRACK-1', pricePaise: 100_000, stock: 50 } })).id;
  const buyer = await prisma.user.create({ data: { phone: PHONE, name: 'Track Buyer', referralCode: 'TRACK-U', email: EMAIL, emailVerifiedAt: new Date() } });
  buyerId = buyer.id;
  buyerToken = signAccessToken({ sub: buyer.id, role: 'CUSTOMER' });
  const other = await prisma.user.create({ data: { phone: '9193000009', name: 'Someone Else', referralCode: 'TRACK-O', email: 'someone@example.com' } });
  otherToken = signAccessToken({ sub: other.id, role: 'CUSTOMER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.refund.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('Track Order: a code, or signed in', () => {
  it('no longer shows an order for its number and phone alone', async () => {
    const o = await bookedOrder();
    const res = await call('GET', `/api/track?orderNumber=${o.orderNumber}&phone=${SHIP_PHONE}`);
    expect(res.status).toBe(410);
    expect(res.text).not.toContain('Tracked Kettle');
    expect((await call('GET', '/api/track/view')).status).toBe(401);
  });

  it('sends no code for a phone or email not on the order, or an unconfirmed email', async () => {
    const o = await bookedOrder();
    expect((await call('POST', '/api/track/request-code', { body: { orderNumber: o.orderNumber, contact: '9193000999' } })).status).toBe(404);
    expect((await call('POST', '/api/track/request-code', { body: { orderNumber: o.orderNumber, contact: 'someone@example.com' } })).status).toBe(404);
    await prisma.user.update({ where: { id: buyerId }, data: { emailVerifiedAt: null } });
    try {
      expect((await call('POST', '/api/track/request-code', { body: { orderNumber: o.orderNumber, contact: EMAIL } })).status).toBe(404);
    } finally {
      await prisma.user.update({ where: { id: buyerId }, data: { emailVerifiedAt: new Date() } });
    }
  });

  it('the phone the order ships to gets a code by SMS; the right code opens that one order', async () => {
    const o = await bookedOrder();
    const sent = await call('POST', '/api/track/request-code', { body: { orderNumber: o.orderNumber.toLowerCase(), contact: SHIP_PHONE } });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.json.data).toMatchObject({ channel: 'sms', sentTo: '91•••••004' });
    const wrong = await call('POST', '/api/track/verify', { body: { orderNumber: o.orderNumber, contact: SHIP_PHONE, code: sent.json.data.devOtp === '000000' ? '111111' : '000000' } });
    expect(wrong.status).toBe(400);
    const ok = await call('POST', '/api/track/verify', { body: { orderNumber: o.orderNumber, contact: SHIP_PHONE, code: sent.json.data.devOtp } });
    expect(ok.status, ok.text).toBe(200);
    const token = ok.json.data.token as string;

    const view = await call('GET', '/api/track/view', { headers: { 'x-track-token': token } });
    expect(view.status).toBe(200);
    const parcel = view.json.data.parcels![0]!;
    expect(parcel).toMatchObject({ awbNumber: o.awb, courierName: 'Delhivery', shopName: 'Track Shop', chip: 'Packed' });
    // The city, never the street, a phone or an email; never the seller's address.
    expect(view.json.data).toMatchObject({ shipCity: 'Pune' });
    for (const secret of ['Hidden Street', SHIP_PHONE, PHONE, EMAIL, 'Seller Secret Road', '110053']) expect(view.text).not.toContain(secret);
    // The token opens nothing else: not as a login, not another order.
    expect((await call('GET', `/api/orders/${o.orderId}`, { token })).status).toBe(401);
    const another = await bookedOrder();
    const theirs = await call('GET', '/api/track/view', { headers: { 'x-track-token': signTrackToken(another.orderId) } });
    expect(theirs.json.data.orderNumber).toBe(another.orderNumber);
    expect(view.json.data.orderNumber).toBe(o.orderNumber);
  });

  it('the account’s confirmed email gets the code by email', async () => {
    const o = await bookedOrder();
    const sent = await call('POST', '/api/track/request-code', { body: { orderNumber: o.orderNumber, contact: EMAIL.toUpperCase() } });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.json.data).toMatchObject({ channel: 'email', sentTo: 'tr•••@example.com' });
    const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { toEmail: EMAIL, kind: 'TRACK_CODE' }, orderBy: { createdAt: 'desc' } });
    expect(mail.subject).toBe(`${sent.json.data.devOtp} is your Clowe tracking code`);
    const ok = await call('POST', '/api/track/verify', { body: { orderNumber: o.orderNumber, contact: EMAIL, code: sent.json.data.devOtp } });
    expect(ok.status, ok.text).toBe(200);
    // The emailed code is not a login code for anyone.
    const login = await call('POST', '/api/auth/verify-otp', { body: { phone: `email:${EMAIL}`, code: sent.json.data.devOtp } });
    expect(login.status).toBe(400);
  });

  it('a signed-in buyer sees their own order without a code, and nobody else’s', async () => {
    const o = await bookedOrder();
    const mine = await call('GET', `/api/track/mine?orderNumber=${o.orderNumber}`, { token: buyerToken });
    expect(mine.status).toBe(200);
    expect(mine.json.data.parcels).toHaveLength(1);
    expect((await call('GET', `/api/track/mine?orderNumber=${o.orderNumber}`, { token: otherToken })).status).toBe(404);
    expect((await call('GET', `/api/track/mine?orderNumber=${o.orderNumber}`)).status).toBe(401);
  });
});

describe('the bar follows Delhivery’s scans', () => {
  it('picked up → out for delivery → failed attempt → out again → delivered; the buyer is told at each', async () => {
    const o = await bookedOrder();
    const day = (h: number, d = 0) => new Date(Date.UTC(2026, 9, 30 + d, h - 5, 30));
    expect(states(await bar(o.orderId))).toBe('done current upcoming upcoming upcoming');

    await scan(o.awb, 'In Transit', 'UD', 'X-PPOM', day(18), 'Shipment picked up');
    let p = await bar(o.orderId);
    expect(states(p)).toBe('done done current upcoming upcoming');
    expect(p.chip).toBe('Arriving');

    await scan(o.awb, 'Dispatched', 'UD', 'X-DDD3FD', day(9, 2), 'Out for delivery');
    p = await bar(o.orderId);
    expect(states(p)).toBe('done done done current upcoming');
    expect(p.chip).toBe('Out for delivery');
    const ofd = await prisma.notification.findMany({ where: { userId: buyerId, type: 'ORDER_OUT_FOR_DELIVERY', body: { contains: o.awb } } });
    expect(ofd).toHaveLength(1);

    await scan(o.awb, 'Pending', 'UD', 'EOD-74', day(13, 2), 'Incomplete address & contact details');
    p = await bar(o.orderId);
    expect(p.chip).toBe('Attempt failed');
    expect(p.exception).toMatchObject({ kind: 'FAILED_ATTEMPT', detail: "The courier couldn't find the address." });
    expect(p.exception!.title).toMatch(/^Delivery attempt 1 of 3 failed/);
    expect(await prisma.notification.count({ where: { userId: buyerId, type: 'ORDER_NDR', title: { contains: o.orderNumber } } })).toBe(1);

    await scan(o.awb, 'Dispatched', 'UD', 'X-DDD3FD', day(9, 3));
    await scan(o.awb, 'Delivered', 'DL', 'EOD-38', day(15, 3) , 'Delivered to consignee');
    p = await bar(o.orderId);
    expect(p.headline).toBe('Delivered on Mon, 2 Nov, 4:00 PM');
    expect(states(p)).toBe('done done done done done');
    expect(p.exception).toBeNull();
    expect(p.scans.map((s) => s.description)).toEqual([
      'Delivered',
      'Out for delivery',
      "Delivery attempt failed — The courier couldn't find the address",
      'Out for delivery',
      'Shipment picked up',
    ]);
    expect(p.scans[0]!.location).toBe('Pune Bhosari, Maharashtra');
    // A second out-for-delivery the next day was a new trip: told again.
    expect(await prisma.notification.count({ where: { userId: buyerId, type: 'ORDER_OUT_FOR_DELIVERY', body: { contains: o.awb } } })).toBe(2);
    // Replayed, the same trip is not told twice.
    await scan(o.awb, 'Dispatched', 'UD', 'X-DDD3FD', day(9, 3));
    expect(await prisma.notification.count({ where: { userId: buyerId, type: 'ORDER_OUT_FOR_DELIVERY', body: { contains: o.awb } } })).toBe(2);
    // The order list: a chip and a headline.
    const list = await call('GET', '/api/orders?limit=50', { token: buyerToken });
    const row = (list.json.data.items as { id: string; tracking: { chip: string; headline: string } }[]).find((r) => r.id === o.orderId)!;
    expect(row.tracking).toMatchObject({ chip: 'Delivered', headline: 'Delivered on Mon, 2 Nov, 4:00 PM' });
  });

  it('RTO: going back to the seller, with the refund; the buyer is emailed', async () => {
    const o = await bookedOrder();
    await scan(o.awb, 'In Transit', 'UD', 'X-PPOM', new Date(Date.now() - 2 * 86_400_000));
    await scan(o.awb, 'In Transit', 'RT', 'RT-101', new Date(), 'Customer refused to accept');
    const p = await bar(o.orderId);
    expect(p.headline).toBe("Couldn't be delivered — going back to the seller");
    expect(p.exception).toMatchObject({ kind: 'RTO' });
    // The mock gateway settles at once; a real one shows "on its way" first.
    expect(p.exception!.detail).toMatch(/^The parcel was refused at the door\. Refund of ₹1,000 issued on /);
    expect(await prisma.notification.count({ where: { userId: buyerId, type: 'ORDER_RTO', title: { contains: o.orderNumber } } })).toBe(1);
    expect(orderSmsCalls.some((c) => c.event === 'RTO' && c.orderNumber === o.orderNumber)).toBe(true);
  });

  it('emails the buyer at out for delivery, a failed attempt and RTO, as well as shipped and delivered', () => {
    for (const type of ['ITEM_SHIPPED', 'ORDER_OUT_FOR_DELIVERY', 'ITEM_DELIVERED', 'ORDER_NDR', 'ORDER_RTO']) expect(EMAIL_NOTIFICATIONS[type]).toBeTruthy();
  });

  it('the seller and the admin see the same bar and scans, read-only', async () => {
    const o = await bookedOrder();
    await scan(o.awb, 'In Transit', 'UD', 'X-PPOM', new Date());
    const seller = await call('GET', `/api/seller/orders/${o.orderId}`, { token: sellerToken });
    expect(seller.status, seller.text).toBe(200);
    expect(seller.json.data.tracking![0]).toMatchObject({ awbNumber: o.awb, chip: 'Arriving' });
    const admin = await call('GET', `/api/admin/orders/${o.orderId}`, { token: adminToken });
    expect(admin.json.data.tracking![0]!.scans[0]!.description).toBe('In transit');
  });
});

describe('Refresh: one courier call per AWB per 10 minutes', () => {
  it('asks Delhivery once, then answers from what it has until 10 minutes pass', async () => {
    const o = await bookedOrder();
    await scan(o.awb, 'In Transit', 'UD', 'X-PPOM', new Date(Date.now() - 3_600_000));
    await prisma.shipment.update({ where: { id: o.shipmentId }, data: { trackedAt: null } });
    const track = vi.spyOn(shippingProvider, 'track').mockResolvedValue([]);
    try {
      const first = await call('POST', `/api/orders/${o.orderId}/tracking/refresh`, { token: buyerToken });
      expect(first.status, first.text).toBe(200);
      expect(first.json.data).toMatchObject({ asked: 1, cached: 0 });
      expect(track).toHaveBeenCalledTimes(1);
      expect(first.json.data.tracking![0]!.lastUpdatedAt).toBeTruthy();

      const again = await call('POST', `/api/orders/${o.orderId}/tracking/refresh`, { token: buyerToken });
      expect(again.json.data).toMatchObject({ asked: 0, cached: 1 });
      expect(again.json.data.nextRefreshAt).toBeTruthy();
      // Through Track Order too: the same AWB, the same limit.
      const viaTrack = await call('POST', '/api/track/refresh', { headers: { 'x-track-token': signTrackToken(o.orderId) } });
      expect(viaTrack.json.data).toMatchObject({ asked: 0, cached: 1 });
      expect(track).toHaveBeenCalledTimes(1);

      await prisma.shipment.update({ where: { id: o.shipmentId }, data: { trackedAt: new Date(Date.now() - 11 * 60_000) } });
      const later = await call('POST', `/api/orders/${o.orderId}/tracking/refresh`, { token: buyerToken });
      expect(later.json.data).toMatchObject({ asked: 1 });
      expect(track).toHaveBeenCalledTimes(2);
    } finally {
      track.mockRestore();
    }
  });

  it('only the buyer can refresh their order', async () => {
    const o = await bookedOrder();
    expect((await call('POST', `/api/orders/${o.orderId}/tracking/refresh`, { token: otherToken })).status).toBe(404);
  });

  it('allows 20 refreshes per 15 minutes from one address, then refuses', async () => {
    const o = await bookedOrder();
    const track = vi.spyOn(shippingProvider, 'track').mockResolvedValue([]);
    try {
      let last = 0;
      for (let i = 0; i < 25 && last !== 429; i++) last = (await call('POST', `/api/orders/${o.orderId}/tracking/refresh`, { token: buyerToken })).status;
      expect(last).toBe(429);
    } finally {
      track.mockRestore();
    }
  });
});
