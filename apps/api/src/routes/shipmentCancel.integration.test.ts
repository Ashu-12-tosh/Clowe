import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { shippingProvider } from '../services/shipping';
import { signAccessToken } from '../utils/jwt';

/**
 * An order cancelled after its parcel was booked cancels the Delhivery
 * booking too — whoever cancels it: the buyer, the seller or an admin. Before
 * pickup the parcel is CANCELLED; a parcel already on its way is cancelled
 * with Delhivery, which brings it back. The cancellation never waits on the
 * courier: a refusal is reported to admins (the mock's is only logged).
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let sellerToken: string;
let buyerToken: string;
let adminToken: string;
let sellerId: string;
let productId: string;
let variantId: string;
let buyerId: string;
let seq = 0;
const orders: string[] = [];

async function call(method: string, path: string, body: unknown, auth: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; error?: { message: string } } };
}

/** A paid order of ours, booked with Delhivery. */
async function booked() {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-11${String(seq).padStart(4, '0')}`, status: 'CONFIRMED', subtotalPaise: 50_000, shippingPaise: 0, totalPaise: 50_000,
      shipName: 'Cancel Buyer', shipPhone: '9191100002', shipLine1: '1 Test Street', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
      payment: { create: { provider: 'mock', amountPaise: 50_000, status: 'PAID' } },
      items: { create: [{ productId, variantId, sellerId, title: 'Cancel Tee', size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'CONFIRMED' }] },
    },
    include: { items: true },
  });
  orders.push(order.id);
  const itemId = order.items[0]!.id;
  expect((await call('PATCH', `/api/seller/orders/${itemId}/status`, { action: 'assign' }, sellerToken)).status).toBe(200);
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
  return { orderId: order.id, itemId, shipmentId: shipment.id, awb: shipment.awbNumber! };
}

const parcel = (id: string) => prisma.shipment.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  const user = await prisma.user.create({ data: { phone: '9191100001', name: 'Cancel Seller', role: Role.SELLER, referralCode: 'CNL-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName: 'Cancel Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
        addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  sellerToken = signAccessToken({ sub: user.id, role: 'SELLER' });
  const admin = await prisma.user.create({ data: { phone: '9191100003', name: 'Cancel Admin', role: Role.ADMIN, referralCode: 'CNL-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const buyer = await prisma.user.create({ data: { phone: '9191100002', name: 'Cancel Buyer', referralCode: 'CNL-B' } });
  buyerId = buyer.id;
  buyerToken = signAccessToken({ sub: buyer.id, role: 'CUSTOMER' });
  const category = await prisma.category.create({ data: { name: 'Cancel Tees', slug: 'cancel-tees', isActive: true } });
  productId = (
    await prisma.product.create({
      data: { sellerId, categoryId: category.id, title: 'Cancel Tee', slug: 'cancel-tee', description: 'For cancellation tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300 },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-CNL', pricePaise: 50_000, stock: 50 } })).id;
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

describe('cancelling an order cancels its Delhivery booking', () => {
  it('when the buyer cancels before pickup', async () => {
    const cancel = vi.spyOn(shippingProvider, 'cancelShipment');
    const o = await booked();
    const r = await call('POST', `/api/orders/${o.orderId}/cancel`, undefined, buyerToken);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(cancel).toHaveBeenCalledWith(o.awb);
    expect(await parcel(o.shipmentId)).toMatchObject({ status: 'CANCELLED' });
    expect((await parcel(o.shipmentId)).cancelledAt).not.toBeNull();
    cancel.mockRestore();
  });

  it('when the seller cancels their part', async () => {
    const o = await booked();
    const r = await call('POST', `/api/seller/orders/${o.orderId}/cancel`, { reason: 'Out of stock, sorry' }, sellerToken);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await parcel(o.shipmentId)).status).toBe('CANCELLED');
  });

  it('when an admin cancels — even a parcel already picked up, which Delhivery brings back', async () => {
    const o = await booked();
    await prisma.shipment.update({ where: { id: o.shipmentId }, data: { status: 'IN_TRANSIT' } });
    const cancel = vi.spyOn(shippingProvider, 'cancelShipment');
    const r = await call('POST', `/api/admin/orders/${o.orderId}/cancel`, { reason: 'Customer asked by phone' }, adminToken);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(cancel).toHaveBeenCalledWith(o.awb);
    const p = await parcel(o.shipmentId);
    expect(p.status).toBe('IN_TRANSIT');
    expect(p.statusText).toMatch(/returning it to the seller/);
    cancel.mockRestore();
  });

  it('never waits on the courier: a refusal still cancels the order, and admins hear of it', async () => {
    Object.defineProperty(shippingProvider, 'name', { value: 'delhivery', configurable: true, writable: true });
    const refuse = vi.spyOn(shippingProvider, 'cancelShipment').mockRejectedValue(new Error('Shipment is already delivered'));
    try {
      const o = await booked();
      const r = await call('POST', `/api/orders/${o.orderId}/cancel`, undefined, buyerToken);
      expect(r.status).toBe(200);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('CANCELLED');
      expect((await parcel(o.shipmentId)).status).toBe('CREATED');
      expect(await prisma.notification.count({ where: { type: 'SHIPMENT_CANCEL_FAILED', title: { contains: o.awb } } })).toBeGreaterThan(0);
    } finally {
      refuse.mockRestore();
      Object.defineProperty(shippingProvider, 'name', { value: 'mock', configurable: true, writable: true });
    }
  });
});
