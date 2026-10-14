import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { shippingProvider } from '../services/shipping';
import { nextPickupSlot } from '../services/shipping/pickups';
import { signAccessToken } from '../utils/jwt';

/**
 * Shipping is asking Delhivery to collect the parcel: one pickup request per
 * pickup address and day, joined by every parcel shipped that day, each
 * needing its packing video. The line is Shipped when Delhivery's pickup scan
 * says so — at once on the mock courier, which collects on the spot.
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

async function confirmedOrder(withClip = true, lines = 1) {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-55${String(seq).padStart(4, '0')}`, status: 'CONFIRMED', subtotalPaise: 50_000 * lines, shippingPaise: 0, totalPaise: 50_000 * lines,
      shipName: 'Pickup Buyer', shipPhone: '9195500002', shipLine1: '1 Test Street', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
      payment: { create: { provider: 'mock', amountPaise: 50_000 * lines, status: 'PAID' } },
      items: {
        create: Array.from({ length: lines }, (_, i) => ({
          productId, variantId, sellerId, title: `Pickup Tee ${i + 1}`, size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'CONFIRMED' as const,
        })),
      },
    },
    include: { items: { orderBy: { title: 'asc' } } },
  });
  orders.push(order.id);
  if (withClip) await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId, fileRef: 'asset:test' } });
  return { orderId: order.id, ids: order.items.map((i) => i.id) };
}

const parcel = (orderId: string) => prisma.shipment.findFirstOrThrow({ where: { orderId }, include: { items: true } });

beforeAll(async () => {
  const user = await prisma.user.create({ data: { phone: '9195500001', name: 'Pickup Seller', role: Role.SELLER, referralCode: 'PUP-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName: 'Pickup Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
        addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  buyerId = (await prisma.user.create({ data: { phone: '9195500002', name: 'Pickup Buyer', referralCode: 'PUP-B' } })).id;
  const category = await prisma.category.create({ data: { name: 'Pickup Tees', slug: 'pickup-tees', isActive: true } });
  productId = (
    await prisma.product.create({
      data: { sellerId, categoryId: category.id, title: 'Pickup Tee', slug: 'pickup-tee', description: 'For pickup tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300 },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-PUP', pricePaise: 50_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the pickup slot', () => {
  it('is the next 11:00 in India at least two hours away, never a Sunday', () => {
    // Wednesday 2026-10-21, 08:00 IST → 11:00 IST the same day.
    expect(nextPickupSlot(new Date('2026-10-21T02:30:00Z')).toISOString()).toBe('2026-10-21T05:30:00.000Z');
    // 10:00 IST is too close: tomorrow.
    expect(nextPickupSlot(new Date('2026-10-21T04:30:00Z')).toISOString()).toBe('2026-10-22T05:30:00.000Z');
    // Saturday afternoon: Monday, not Sunday.
    expect(nextPickupSlot(new Date('2026-10-24T09:30:00Z')).toISOString()).toBe('2026-10-26T05:30:00.000Z');
  });
});

describe('shipping asks Delhivery to collect', () => {
  it('on the mock courier, collects at once: one request for the day, the parcel on its way', async () => {
    const ask = vi.spyOn(shippingProvider, 'requestPickup');
    const a = await confirmedOrder();
    const b = await confirmedOrder();
    expect((await call('PATCH', `/api/seller/orders/${a.ids[0]}/status`, { action: 'ship' })).status).toBe(200);
    expect((await call('PATCH', `/api/seller/orders/${b.ids[0]}/status`, { action: 'ship' })).status).toBe(200);
    // The second parcel joins the day's request instead of asking again.
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toMatchObject({ warehouseName: `CLW-${sellerId}`, expectedPackages: 1 });
    const [pa, pb] = [await parcel(a.orderId), await parcel(b.orderId)];
    expect(pa.pickupRequestId).toMatch(/^MOCK-PU-/);
    expect(pb.pickupRequestId).toBe(pa.pickupRequestId);
    expect(pa.pickupScheduledFor).not.toBeNull();
    expect(pa).toMatchObject({ status: 'IN_TRANSIT' });
    expect(pa.items.map((i) => i.status)).toEqual(['SHIPPED']);
    ask.mockRestore();
  });

  it('sends a box whole: shipping one line of a parcel ships the parcel, and the other line counts as shipped too', async () => {
    const o = await confirmedOrder(true, 2);
    await call('POST', '/api/seller/orders/bulk', { itemIds: o.ids, action: 'assign' });
    const r = await call('POST', '/api/seller/orders/bulk', { itemIds: o.ids, action: 'ship' });
    expect(r.json.data).toMatchObject({ updated: 2, skipped: [] });
    expect((await parcel(o.orderId)).items.map((i) => i.status)).toEqual(['SHIPPED', 'SHIPPED']);
  });

  it('needs the packing video, and asks for nothing without it', async () => {
    const ask = vi.spyOn(shippingProvider, 'requestPickup');
    const o = await confirmedOrder(false);
    expect((await call('PATCH', `/api/seller/orders/${o.ids[0]}/status`, { action: 'ship' })).status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
    ask.mockRestore();
  });

  it('with Delhivery, waits for the pickup scan: the line stays to-ship, the parcel is asked for', async () => {
    Object.defineProperty(shippingProvider, 'name', { value: 'delhivery', configurable: true, writable: true });
    try {
      const o = await confirmedOrder();
      const r = await call('PATCH', `/api/seller/orders/${o.ids[0]}/status`, { action: 'ship' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const p = await parcel(o.orderId);
      expect(p).toMatchObject({ status: 'PICKUP_REQUESTED' });
      expect(p.items.map((i) => i.status)).toEqual(['CONFIRMED']);
      // Asking again is fine and changes nothing.
      expect((await call('PATCH', `/api/seller/orders/${o.ids[0]}/status`, { action: 'ship' })).status).toBe(200);
      expect((await parcel(o.orderId)).items.map((i) => i.status)).toEqual(['CONFIRMED']);
    } finally {
      Object.defineProperty(shippingProvider, 'name', { value: 'mock', configurable: true, writable: true });
    }
  });
});
