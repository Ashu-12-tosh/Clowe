import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { shippingProvider } from '../services/shipping';
import type { MockShippingProvider } from '../services/shipping/MockShippingProvider';
import { pollOpenShipments } from '../services/shipping/tracking';
import { signAccessToken } from '../utils/jwt';

/**
 * Approving a return books a Delhivery reverse pickup: collected from the
 * buyer's delivery address, delivered to the seller's own pickup address.
 * Its scans mark the return picked up and tell the seller when it has
 * arrived; the order's lines are never moved by them. If Delhivery refuses,
 * the return stays approved and can be booked again.
 */

const prisma = new PrismaClient();
const mock = shippingProvider as MockShippingProvider;
let server: Server;
let base: string;
let token: string;
let adminToken: string;
let sellerId: string;
let productId: string;
let variantId: string;
let buyerId: string;
let seq = 0;
const orders: string[] = [];

async function call(method: string, path: string, body?: unknown, auth = token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; error?: { message: string } } };
}

/** A delivered line the buyer has asked to return. */
async function returnRequested(pincode = '411001') {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-22${String(seq).padStart(4, '0')}`, status: 'DELIVERED', subtotalPaise: 50_000, shippingPaise: 0, totalPaise: 50_000,
      shipName: 'Return Buyer', shipPhone: '9192200002', shipLine1: '1 Test Street', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: pincode,
      payment: { create: { provider: 'mock', amountPaise: 50_000, status: 'PAID' } },
      items: { create: [{ productId, variantId, sellerId, title: 'Return Tee', size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'RETURN_REQUESTED', deliveredAt: new Date() }] },
    },
    include: { items: true },
  });
  orders.push(order.id);
  const itemId = order.items[0]!.id;
  const r = await prisma.return.create({
    data: { rmaNumber: `RMA-2026-22${String(seq).padStart(4, '0')}`, orderItemId: itemId, userId: buyerId, reasonCategory: 'SIZE_FIT', reason: 'Too small' },
  });
  return { orderId: order.id, itemId, returnId: r.id };
}

const reverse = (returnId: string) => prisma.shipment.findUnique({ where: { returnId } });

beforeAll(async () => {
  const user = await prisma.user.create({ data: { phone: '9192200001', name: 'Return Seller', role: Role.SELLER, referralCode: 'RTN-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName: 'Return Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
        addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  const admin = await prisma.user.create({ data: { phone: '9192200003', name: 'Return Admin', role: Role.ADMIN, referralCode: 'RTN-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  buyerId = (await prisma.user.create({ data: { phone: '9192200002', name: 'Return Buyer', referralCode: 'RTN-B' } })).id;
  const category = await prisma.category.create({ data: { name: 'Return Tees', slug: 'return-tees', isActive: true } });
  productId = (
    await prisma.product.create({
      data: { sellerId, categoryId: category.id, title: 'Return Tee', slug: 'return-tee', description: 'For return pickup tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300 },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-RTN', pricePaise: 50_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.sellerLedgerEntry.deleteMany({ where: { sellerId } });
  await prisma.return.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a return, collected by Delhivery', () => {
  it('is booked when the seller approves it, from the buyer to the seller’s own address', async () => {
    const r = await returnRequested();
    const approved = await call('PATCH', `/api/seller/returns/${r.returnId}`, { action: 'approve' });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    const s = await reverse(r.returnId);
    expect(s).toMatchObject({ kind: 'REVERSE', status: 'PICKUP_REQUESTED', paymentType: 'PICKUP', sellerId, orderId: r.orderId });
    expect(s!.awbNumber).toMatch(/^AWB/);
    expect(approved.json.data.pickup).toMatchObject({ awbNumber: s!.awbNumber, status: 'PICKUP_REQUESTED' });
    expect(await prisma.notification.count({ where: { userId: buyerId, type: 'RETURN_PICKUP_BOOKED', body: { contains: s!.awbNumber! } } })).toBe(1);
  });

  it('is marked picked up at the scan, and the seller told when it arrives — the order line untouched', async () => {
    const r = await returnRequested();
    await call('PATCH', `/api/seller/returns/${r.returnId}`, { action: 'approve' });
    const s = await reverse(r.returnId);
    const pickedUp = new Date('2026-10-26T05:00:00Z');
    mock.simulate(s!.awbNumber!, 'PICKED_UP', pickedUp);
    await pollOpenShipments();
    expect(await prisma.return.findUniqueOrThrow({ where: { id: r.returnId } })).toMatchObject({ status: 'APPROVED', pickedUpAt: pickedUp });
    mock.simulate(s!.awbNumber!, 'DELIVERED');
    await pollOpenShipments();
    expect((await reverse(r.returnId))!.status).toBe('DELIVERED');
    expect(await prisma.notification.count({ where: { type: 'RETURN_ARRIVED', body: { contains: s!.awbNumber! } } })).toBe(1);
    // Receiving it, with the seller's check, stays the seller's.
    expect((await prisma.return.findUniqueOrThrow({ where: { id: r.returnId } })).status).toBe('APPROVED');
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: r.itemId } })).status).toBe('RETURN_REQUESTED');
  });

  it('stays approved when Delhivery refuses, tells the seller and admins, and can be booked again', async () => {
    const r = await returnRequested('999999');
    const approved = await call('PATCH', `/api/seller/returns/${r.returnId}`, { action: 'approve' });
    expect(approved.status).toBe(200);
    expect((await prisma.return.findUniqueOrThrow({ where: { id: r.returnId } })).status).toBe('APPROVED');
    expect(await reverse(r.returnId)).toBeNull();
    expect(await prisma.notification.count({ where: { type: 'RETURN_PICKUP_FAILED', body: { contains: '999999' } } })).toBeGreaterThan(1);
    const again = await call('POST', `/api/seller/returns/${r.returnId}/pickup`);
    expect(again.status).toBe(400);
    // The buyer's address is corrected; booking again works.
    await prisma.order.update({ where: { id: r.orderId }, data: { shipPincode: '411001' } });
    const booked = await call('POST', `/api/seller/returns/${r.returnId}/pickup`);
    expect(booked.status, JSON.stringify(booked.json)).toBe(200);
    expect((booked.json.data.pickup as { status: string }).status).toBe('PICKUP_REQUESTED');
    // Booking a third time changes nothing.
    await call('POST', `/api/seller/returns/${r.returnId}/pickup`);
    expect(await prisma.shipment.count({ where: { returnId: r.returnId } })).toBe(1);
  });

  it('is booked when an admin approves it too', async () => {
    const r = await returnRequested();
    const res = await call('POST', `/api/admin/returns/${r.returnId}/action`, { action: 'APPROVE' }, adminToken);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await reverse(r.returnId))!.status).toBe('PICKUP_REQUESTED');
  });
});

describe('return pickup freight', () => {
  /** The mock's return leg: 1.2 × the ₹60 test rate, GST included. */
  const RETURN_LEG = 7_200;
  const returnRows = (orderId: string) => prisma.sellerLedgerEntry.findMany({ where: { orderId, type: 'RETURN_FREIGHT' } });

  it('is the seller’s, posted once when the return reaches them, at Delhivery’s charge', async () => {
    const quote = vi.spyOn(shippingProvider, 'quote');
    const r = await returnRequested();
    await call('PATCH', `/api/seller/returns/${r.returnId}`, { action: 'approve' });
    const s = await reverse(r.returnId);
    mock.simulate(s!.awbNumber!, 'PICKED_UP');
    await pollOpenShipments();
    expect(await returnRows(r.orderId)).toHaveLength(0); // not until it arrives
    mock.simulate(s!.awbNumber!, 'DELIVERED');
    await pollOpenShipments();
    await pollOpenShipments();
    expect((await returnRows(r.orderId)).map((e) => e.amountPaise)).toEqual([-RETURN_LEG]);
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ kind: 'DTO', originPincode: '411001', destinationPincode: '110053' }));
    quote.mockRestore();
    const fees = (await call('GET', '/api/seller/payouts/overview')).json.data.fees as { returnFreightPaise: number };
    expect(fees.returnFreightPaise).toBeGreaterThanOrEqual(RETURN_LEG);
  });

  it('is caught up before the payout figures if the charges API was down', async () => {
    const r = await returnRequested();
    await call('PATCH', `/api/seller/returns/${r.returnId}`, { action: 'approve' });
    const s = await reverse(r.returnId);
    mock.simulate(s!.awbNumber!, 'PICKED_UP');
    mock.simulate(s!.awbNumber!, 'DELIVERED');
    const down = vi.spyOn(shippingProvider, 'quote').mockRejectedValue(new Error('Delhivery did not answer in time'));
    await pollOpenShipments();
    expect(await returnRows(r.orderId)).toHaveLength(0);
    down.mockRestore();
    expect((await call('GET', '/api/seller/payouts/overview')).status).toBe(200);
    expect((await returnRows(r.orderId)).map((e) => e.amountPaise)).toEqual([-RETURN_LEG]);
  });
});
