import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchedEtaWindow, orderEtaWindow, PO_BOX_MESSAGE, type OrderDetailView } from '@clowe/shared';
import { createApp } from '../app';
import { shippingProvider } from '../services/shipping';
import type { MockShippingProvider } from '../services/shipping/MockShippingProvider';
import { pollOpenShipments } from '../services/shipping/tracking';
import { sweepLostShipments } from '../services/shipping/lostParcels';
import { postDeliveryEntries } from '../services/sellerLedgerService';
import { signAccessToken } from '../utils/jwt';

/**
 * The Shipping Policy, as the code keeps it: delivery dated by the
 * destination's zone (3.2), no post office boxes (2.3), failed attempts
 * counted out of three (6.5), and a parcel 15 days past its estimate and
 * untraceable treated as lost — the buyer then choosing a free replacement or
 * a full refund (9.2). Uses the mock courier with Delhivery's behaviour (a
 * pickup waits for its scan) and its simulate() to play the scans.
 */

const prisma = new PrismaClient();
const mock = shippingProvider as MockShippingProvider;
let server: Server;
let base: string;
let sellerToken: string;
let buyerToken: string;
let otherToken: string;
let sellerId: string;
let productId: string;
let variantId: string;
let buyerId: string;
let seq = 0;
const DAY = 24 * 60 * 60 * 1000;
const istDay = (d: Date | string) => new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, auth = buyerToken) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

/** An order shipped to the courier and picked up at `pickedUpAt`. */
async function pickedUp(pickedUpAt: Date, opts: { cod?: boolean } = {}) {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-45${String(seq).padStart(4, '0')}`, status: 'CONFIRMED', subtotalPaise: 150_000, shippingPaise: 0, totalPaise: 150_000,
      paymentMethod: opts.cod ? 'COD' : 'UPI', shipName: 'Policy Buyer', shipPhone: '9194500002', shipLine1: '1 Test Street', shipCity: 'Jaipur', shipState: 'Rajasthan', shipPincode: '302001',
      payment: { create: { provider: 'mock', amountPaise: 150_000, status: opts.cod ? 'CREATED' : 'PAID' } },
      items: { create: [{ productId, variantId, sellerId, title: 'Policy Kurta', size: '', color: '', pricePaise: 150_000, quantity: 1, status: 'CONFIRMED' }] },
    },
    include: { items: true },
  });
  await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId, fileRef: 'asset:test' } });
  const itemId = order.items[0]!.id;
  const r = await call('PATCH', `/api/seller/orders/${itemId}/status`, { action: 'ship' }, sellerToken);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
  mock.simulate(shipment.awbNumber!, 'PICKED_UP', pickedUpAt);
  await pollOpenShipments();
  return { orderId: order.id, itemId, shipmentId: shipment.id, awb: shipment.awbNumber! };
}

/** A parcel 40 days out with no scan since pickup: flagged lost by the sweep. */
async function lostParcel(opts: { cod?: boolean } = {}) {
  const at = new Date(Date.now() - 40 * DAY);
  const p = await pickedUp(at, opts);
  await prisma.shipment.update({ where: { id: p.shipmentId }, data: { lastScanAt: at } });
  await sweepLostShipments();
  return p;
}

beforeAll(async () => {
  Object.defineProperty(shippingProvider, 'name', { value: 'delhivery', configurable: true, writable: true });
  const user = await prisma.user.create({ data: { phone: '9194500001', name: 'Policy Seller', role: Role.SELLER, referralCode: 'SPL-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName: 'Policy Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
        addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  sellerToken = signAccessToken({ sub: user.id, role: 'SELLER' });
  const buyer = await prisma.user.create({ data: { phone: '9194500002', name: 'Policy Buyer', referralCode: 'SPL-B' } });
  buyerId = buyer.id;
  buyerToken = signAccessToken({ sub: buyer.id, role: 'CUSTOMER' });
  const other = await prisma.user.create({ data: { phone: '9194500003', name: 'Someone Else', referralCode: 'SPL-O' } });
  otherToken = signAccessToken({ sub: other.id, role: 'CUSTOMER' });
  await prisma.user.create({ data: { phone: '9194500004', name: 'Policy Admin', role: Role.ADMIN, referralCode: 'SPL-A' } });
  const category = await prisma.category.create({ data: { name: 'Policy Kurtas', slug: 'policy-kurtas', isActive: true } });
  productId = (
    await prisma.product.create({
      data: { sellerId, categoryId: category.id, title: 'Policy Kurta', slug: 'policy-kurta', description: 'For shipping policy tests.', basePricePaise: 150_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300 },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-SPL', pricePaise: 150_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  Object.defineProperty(shippingProvider, 'name', { value: 'mock', configurable: true, writable: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('delivery dated by zone (3.1, 3.2)', () => {
  it('quotes processing plus the zone’s transit, metro sooner than remote', async () => {
    const quote = async (pincode: string) =>
      (await call<{ options: { etaFrom: string; etaTo: string; label: string }[] }>('GET', `/api/delivery/options?pincode=${pincode}`)).json.data.options[0]!;
    const metro = await quote('110073');
    const remote = await quote('781001');
    const now = new Date();
    expect(istDay(metro.etaTo)).toBe(istDay(orderEtaWindow('110073', now).to));
    expect(istDay(remote.etaTo)).toBe(istDay(orderEtaWindow('781001', now).to));
    expect(new Date(remote.etaTo).getTime()).toBeGreaterThan(new Date(metro.etaTo).getTime());
    expect(metro.label).toContain('Metro city');
    expect(remote.label).toContain('Remote area');
  });

  it('dates the order by its address, and the parcel again from dispatch', async () => {
    const address = await prisma.address.create({
      data: { userId: buyerId, name: 'Policy Buyer', phone: '9194500002', line1: '9 Hill Road', city: 'Guwahati', state: 'Assam', pincode: '781001' },
    });
    expect((await call('POST', '/api/cart/items', { variantId, quantity: 1 })).status).toBe(200);
    const options = await call<{ etaTo: string }[]>('GET', `/api/cart/delivery-options?addressId=${address.id}`);
    expect(istDay(options.json.data[0]!.etaTo)).toBe(istDay(orderEtaWindow('781001').to));
    const co = await call<{ orderId: string }>('POST', '/api/orders/checkout', { addressId: address.id, paymentMethod: 'UPI' });
    expect(co.status, JSON.stringify(co.json)).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: co.json.data.orderId } });
    expect(istDay(order.etaTo!)).toBe(istDay(orderEtaWindow('781001', order.createdAt).to));

    const at = new Date('2026-10-22T06:00:00Z');
    const p = await pickedUp(at);
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: p.shipmentId } });
    const expected = dispatchedEtaWindow('302001', at);
    expect(shipment.etaFrom?.toISOString()).toBe(expected.from.toISOString());
    expect(shipment.etaTo?.toISOString()).toBe(expected.to.toISOString());
  });
});

describe('no post office boxes (2.3)', () => {
  it('refuses a PO box address when saved, and at checkout for one saved before the rule', async () => {
    const saved = await call('POST', '/api/addresses', { name: 'Policy Buyer', phone: '9194500002', line1: 'PO Box 55', city: 'Delhi', state: 'Delhi', pincode: '110001' });
    expect(saved.status).toBe(400);
    expect(JSON.stringify(saved.json)).toContain('post office box');

    const legacy = await prisma.address.create({
      data: { userId: buyerId, name: 'Policy Buyer', phone: '9194500002', line1: 'P.O. Box 1234', city: 'Delhi', state: 'Delhi', pincode: '110001' },
    });
    expect((await call('POST', '/api/cart/items', { variantId, quantity: 1 })).status).toBe(200);
    const co = await call('POST', '/api/orders/checkout', { addressId: legacy.id, paymentMethod: 'UPI' });
    expect(co.status).toBe(400);
    expect(co.json.error).toMatchObject({ code: 'PO_BOX_ADDRESS', message: PO_BOX_MESSAGE });
  });
});

describe('delivery attempts (6.5)', () => {
  it('counts each failed attempt and tells the buyer which of three it was', async () => {
    const p = await pickedUp(new Date());
    mock.simulate(p.awb, 'OUT_FOR_DELIVERY');
    mock.simulate(p.awb, 'DELIVERY_FAILED');
    await pollOpenShipments();
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: p.shipmentId } })).deliveryAttempts).toBe(1);
    mock.simulate(p.awb, 'OUT_FOR_DELIVERY');
    await pollOpenShipments();
    mock.simulate(p.awb, 'DELIVERY_FAILED');
    await pollOpenShipments();
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: p.shipmentId } })).deliveryAttempts).toBe(2);
    const notes = await prisma.notification.findMany({ where: { userId: buyerId, type: 'ORDER_NDR', linkHref: `/account/orders/${p.orderId}` }, orderBy: { createdAt: 'asc' } });
    expect(notes.map((n) => n.title)).toEqual([expect.stringContaining('attempt 1 of 3'), expect.stringContaining('attempt 2 of 3')]);
    const detail = await call<OrderDetailView>('GET', `/api/orders/${p.orderId}`);
    expect(detail.json.data.items[0]!.parcel).toMatchObject({ deliveryAttempts: 2, lost: false });
  });
});

describe('lost in transit (9.2)', () => {
  it('leaves a late parcel that is still being scanned alone', async () => {
    const at = new Date(Date.now() - 40 * DAY);
    const p = await pickedUp(at);
    await prisma.shipment.update({ where: { id: p.shipmentId }, data: { lastScanAt: new Date(Date.now() - DAY) } });
    await sweepLostShipments();
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: p.shipmentId } })).lostFlaggedAt).toBeNull();
  });

  it('flags one 15 days past its estimate and silent, and asks the buyer', async () => {
    const p = await lostParcel();
    const s = await prisma.shipment.findUniqueOrThrow({ where: { id: p.shipmentId } });
    expect(s.status).toBe('LOST');
    expect(s.lostFlaggedAt).not.toBeNull();
    const asked = await prisma.notification.findFirst({ where: { userId: buyerId, type: 'SHIPMENT_LOST', linkHref: `/account/orders/${p.orderId}` } });
    expect(asked?.body).toContain('replacement or a full refund');
    const detail = await call<OrderDetailView>('GET', `/api/orders/${p.orderId}`);
    expect(detail.json.data.items[0]!.parcel).toMatchObject({ lost: true, lostChoice: null });
  });

  it('flags it at once when the courier says lost', async () => {
    const p = await pickedUp(new Date());
    mock.simulate(p.awb, 'LOST');
    await pollOpenShipments();
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: p.shipmentId } })).lostFlaggedAt).not.toBeNull();
  });

  it('refunds in full what was paid, once, and only to the buyer', async () => {
    const p = await lostParcel();
    const path = `/api/orders/${p.orderId}/lost-parcels/${p.shipmentId}/choice`;
    expect((await call('POST', path, { choice: 'REFUND' }, otherToken)).status).toBe(404);
    const r = await call<{ choice: string; refund: { amountPaise: number } }>('POST', path, { choice: 'REFUND' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data).toMatchObject({ choice: 'REFUND', refund: { amountPaise: 150_000 } });
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: p.itemId } })).status).toBe('CANCELLED');
    const again = await call('POST', path, { choice: 'REPLACEMENT' });
    expect(again.json.error?.code).toBe('ALREADY_CHOSEN');
  });

  it('sends a free replacement: a new ₹0 order for the same item, from stock, with no new invoice', async () => {
    const p = await lostParcel();
    const before = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    const r = await call<{ choice: string; replacement: { orderId: string; orderNumber: string } }>(
      'POST', `/api/orders/${p.orderId}/lost-parcels/${p.shipmentId}/choice`, { choice: 'REPLACEMENT' },
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.choice).toBe('REPLACEMENT');
    const rep = await prisma.order.findUniqueOrThrow({ where: { id: r.json.data.replacement.orderId }, include: { items: true, payment: true } });
    expect(rep).toMatchObject({ status: 'CONFIRMED', paymentMethod: 'REPLACEMENT', totalPaise: 0, shipPincode: '302001' });
    expect(rep.payment).toMatchObject({ status: 'PAID', amountPaise: 0 });
    expect(rep.items[0]).toMatchObject({ variantId, quantity: 1, status: 'CONFIRMED', replacementOfId: p.itemId });
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock).toBe(before - 1);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: p.itemId } })).status).toBe('CANCELLED');
    expect(await prisma.refund.count({ where: { orderId: p.orderId } })).toBe(0);
    const detail = await call<OrderDetailView>('GET', `/api/orders/${p.orderId}`);
    expect(detail.json.data.items[0]!.replacedBy?.orderNumber).toBe(rep.orderNumber);
    expect((await call<unknown[]>('GET', `/api/orders/${rep.id}/invoices`)).json.data).toEqual([]);

    // Delivered, it is the sale (the lost original never was).
    await prisma.orderItem.update({ where: { id: rep.items[0]!.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    expect(await postDeliveryEntries(rep.items[0]!.id)).toBeGreaterThan(0);
  });

  it('refunds instead when the item is out of stock', async () => {
    const p = await lostParcel();
    const stock = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    await prisma.productVariant.update({ where: { id: variantId }, data: { stock: 0 } });
    try {
      const r = await call<{ choice: string; fellBackToRefund: boolean; refund: { amountPaise: number } }>(
        'POST', `/api/orders/${p.orderId}/lost-parcels/${p.shipmentId}/choice`, { choice: 'REPLACEMENT' },
      );
      expect(r.json.data).toMatchObject({ choice: 'REFUND', fellBackToRefund: true, refund: { amountPaise: 150_000 } });
      expect((await prisma.shipment.findUniqueOrThrow({ where: { id: p.shipmentId } })).lostChoice).toBe('REFUND');
    } finally {
      await prisma.productVariant.update({ where: { id: variantId }, data: { stock } });
    }
  });

  it('has nothing to refund on a COD parcel that never arrived, and a replacement of it is COD as before', async () => {
    const refunded = await lostParcel({ cod: true });
    const r = await call<{ refund: unknown }>('POST', `/api/orders/${refunded.orderId}/lost-parcels/${refunded.shipmentId}/choice`, { choice: 'REFUND' });
    expect(r.json.data.refund).toBeNull();

    const replaced = await lostParcel({ cod: true });
    const rr = await call<{ replacement: { orderId: string } }>('POST', `/api/orders/${replaced.orderId}/lost-parcels/${replaced.shipmentId}/choice`, { choice: 'REPLACEMENT' });
    const rep = await prisma.order.findUniqueOrThrow({ where: { id: rr.json.data.replacement.orderId }, include: { payment: true } });
    expect(rep).toMatchObject({ paymentMethod: 'COD', totalPaise: 150_000 });
    expect(rep.payment).toMatchObject({ provider: 'cod', status: 'CREATED', amountPaise: 150_000 });
  });
});

describe('a replacement for something delivered (an exchange)', () => {
  it('earns the seller nothing more on delivery: the sale was the original’s', async () => {
    const order = await prisma.order.create({
      data: {
        userId: buyerId, orderNumber: `CLW-2026-459${String(++seq).padStart(3, '0')}`, status: 'DELIVERED', subtotalPaise: 150_000, shippingPaise: 0, totalPaise: 150_000,
        paymentMethod: 'UPI', shipName: 'Policy Buyer', shipPhone: '9194500002', shipLine1: '1 Test Street', shipCity: 'Jaipur', shipState: 'Rajasthan', shipPincode: '302001',
        items: { create: [{ productId, variantId, sellerId, title: 'Policy Kurta', size: '', color: '', pricePaise: 150_000, quantity: 1, status: 'DELIVERED', deliveredAt: new Date() }] },
      },
      include: { items: true },
    });
    const rep = await prisma.order.create({
      data: {
        userId: buyerId, orderNumber: `CLW-2026-459${String(++seq).padStart(3, '0')}`, status: 'DELIVERED', subtotalPaise: 0, shippingPaise: 0, totalPaise: 0,
        paymentMethod: 'REPLACEMENT', shipName: 'Policy Buyer', shipPhone: '9194500002', shipLine1: '1 Test Street', shipCity: 'Jaipur', shipState: 'Rajasthan', shipPincode: '302001',
        items: { create: [{ productId, variantId, sellerId, title: 'Policy Kurta', size: '', color: '', pricePaise: 150_000, quantity: 1, status: 'DELIVERED', deliveredAt: new Date(), replacementOfId: order.items[0]!.id }] },
      },
      include: { items: true },
    });
    expect(await postDeliveryEntries(rep.items[0]!.id)).toBe(0);
  });
});
