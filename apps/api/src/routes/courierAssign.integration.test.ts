import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * Courier assignment on the seller's orders. A courier and AWB used to be
 * booked only at "Ship", so labels printed before handover said "Courier not
 * assigned". Now "assign" books them without shipping (no packing video yet),
 * can be repeated to change courier until it ships, and "ship" reuses the
 * AWB on the label.
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

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; error?: { message: string } } };
}

/** A confirmed order with one line of ours, optionally with its packing clip. */
async function confirmedLine(withClip: boolean) {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      userId: buyerId,
      orderNumber: `CLW-2026-77${String(seq).padStart(4, '0')}`,
      status: 'CONFIRMED',
      subtotalPaise: 50_000,
      shippingPaise: 0,
      totalPaise: 50_000,
      shipName: 'Assign Buyer',
      shipPhone: '9198900002',
      shipLine1: '1 Test Street',
      shipCity: 'Pune',
      shipState: 'Maharashtra',
      shipPincode: '411001',
      items: {
        create: [{ productId, variantId, sellerId, title: 'Assign Test Tee', size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'CONFIRMED' }],
      },
    },
    include: { items: true },
  });
  orders.push(order.id);
  if (withClip) await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId, fileRef: 'asset:test' } });
  return order.items[0]!.id;
}

const line = (id: string) => prisma.orderItem.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  const user = await prisma.user.create({ data: { phone: '9198900001', name: 'Assign Seller', role: Role.SELLER, referralCode: 'ASN-S' } });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'Assign Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5' },
  });
  sellerId = seller.id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  buyerId = (await prisma.user.create({ data: { phone: '9198900002', name: 'Assign Buyer', referralCode: 'ASN-B' } })).id;
  const category = await prisma.category.create({ data: { name: 'Assign Tees', slug: 'assign-tees', isActive: true } });
  const product = await prisma.product.create({
    data: { sellerId, categoryId: category.id, title: 'Assign Test Tee', slug: 'assign-test-tee', description: 'For courier assignment tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  productId = product.id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-ASN', pricePaise: 50_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('assigning a courier', () => {
  it('books the courier and AWB without shipping, and needs no packing video yet', async () => {
    const id = await confirmedLine(false);
    const r = await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign', courier: 'BlueDart' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const after = await line(id);
    expect(after).toMatchObject({ status: 'CONFIRMED', courierName: 'BlueDart', shippedAt: null });
    expect(after.awbNumber).toMatch(/^AWB/);
  });

  it('can be changed until the item ships', async () => {
    const id = await confirmedLine(false);
    await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign', courier: 'BlueDart' });
    const first = await line(id);
    await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign', courier: 'DTDC' });
    const second = await line(id);
    expect(second.courierName).toBe('DTDC');
    expect(second.awbNumber).not.toBe(first.awbNumber);
  });

  it('is what ships: the AWB on the label is reused', async () => {
    const id = await confirmedLine(true);
    await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign', courier: 'Delhivery' });
    const assigned = await line(id);
    const r = await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'ship' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const shipped = await line(id);
    expect(shipped).toMatchObject({ status: 'SHIPPED', courierName: 'Delhivery', awbNumber: assigned.awbNumber });
    expect(shipped.shippedAt).not.toBeNull();
  });

  it('is refused once the item has shipped', async () => {
    const id = await confirmedLine(true);
    await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'ship', courier: 'XpressBees' });
    const r = await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign', courier: 'DTDC' });
    expect(r.status).toBe(400);
    expect((await line(id)).courierName).toBe('XpressBees');
  });

  it('works in bulk, and the order shows the line can still be assigned', async () => {
    const a = await confirmedLine(false);
    const b = await confirmedLine(false);
    const r = await call('POST', '/api/seller/orders/bulk', { itemIds: [a, b], action: 'assign', courier: 'Ekart Logistics' });
    expect(r.json.data).toMatchObject({ updated: 2, skipped: [] });
    const orderId = (await line(a)).orderId;
    const detail = await call('GET', `/api/seller/orders/${orderId}`);
    const lines = detail.json.data.lines as Array<{ canAssign: boolean; courierName: string }>;
    expect(lines[0]).toMatchObject({ canAssign: true, courierName: 'Ekart Logistics' });
  });
});
