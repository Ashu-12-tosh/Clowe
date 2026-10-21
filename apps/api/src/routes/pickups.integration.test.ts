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
  // Wednesday 2026-10-21 (IST = UTC + 5:30).
  const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);

  it('before 2 PM: today, at the seller’s slot or two hours from now (on the half hour), whichever is later', () => {
    expect(nextPickupSlot(ist('2026-10-21', '08:00')).toISOString()).toBe(ist('2026-10-21', '11:00').toISOString());
    // 10:00 is less than two hours before 11:00: 12:00 today, no longer tomorrow.
    expect(nextPickupSlot(ist('2026-10-21', '10:00')).toISOString()).toBe(ist('2026-10-21', '12:00').toISOString());
    expect(nextPickupSlot(ist('2026-10-21', '13:59')).toISOString()).toBe(ist('2026-10-21', '16:00').toISOString());
  });

  it('from 2 PM: the next pickup day at the slot — never a Sunday', () => {
    expect(nextPickupSlot(ist('2026-10-21', '14:00')).toISOString()).toBe(ist('2026-10-22', '11:00').toISOString());
    // Saturday afternoon and all of Sunday: Monday.
    expect(nextPickupSlot(ist('2026-10-24', '15:00')).toISOString()).toBe(ist('2026-10-26', '11:00').toISOString());
    expect(nextPickupSlot(ist('2026-10-25', '09:00')).toISOString()).toBe(ist('2026-10-26', '11:00').toISOString());
  });

  it('from 22:00 — too late for Delhivery to promise tomorrow — the first pickup day after tomorrow', () => {
    // Monday 2026-10-19 23:00 → Wednesday; 21:59 is still Tuesday.
    expect(nextPickupSlot(ist('2026-10-19', '23:00')).toISOString()).toBe(ist('2026-10-21', '11:00').toISOString());
    expect(nextPickupSlot(ist('2026-10-19', '22:00')).toISOString()).toBe(ist('2026-10-21', '11:00').toISOString());
    expect(nextPickupSlot(ist('2026-10-19', '21:59')).toISOString()).toBe(ist('2026-10-20', '11:00').toISOString());
    // Friday 23:00 → Monday (Saturday is the next pickup day, Sunday never is).
    expect(nextPickupSlot(ist('2026-10-23', '23:00')).toISOString()).toBe(ist('2026-10-26', '11:00').toISOString());
    // Pickup days only: Tuesday and Thursday, asked Monday 23:00 → Thursday.
    expect(nextPickupSlot(ist('2026-10-19', '23:00'), { slot: '15:00', days: [2, 4] }).toISOString()).toBe(ist('2026-10-22', '15:00').toISOString());
    // Saturday 22:30 → Monday, not Tuesday: Sunday was never tomorrow's pickup.
    expect(nextPickupSlot(ist('2026-10-24', '22:30')).toISOString()).toBe(ist('2026-10-26', '11:00').toISOString());
    expect(nextPickupSlot(ist('2026-10-24', '21:59')).toISOString()).toBe(ist('2026-10-26', '11:00').toISOString());
    // Monday, Wednesday, Friday; Monday 23:00 → Wednesday, not Friday.
    expect(nextPickupSlot(ist('2026-10-19', '23:00'), { slot: '11:00', days: [1, 3, 5] }).toISOString()).toBe(ist('2026-10-21', '11:00').toISOString());
  });

  it('follows the seller’s own time and days, and skips today after a failed pickup', () => {
    const tueThu = { slot: '15:00', days: [2, 4] };
    // Wednesday is not a pickup day for them: Thursday at 15:00.
    expect(nextPickupSlot(ist('2026-10-21', '09:00'), tueThu).toISOString()).toBe(ist('2026-10-22', '15:00').toISOString());
    // Thursday morning: today at 15:00. Thursday after 2 PM: next Tuesday.
    expect(nextPickupSlot(ist('2026-10-22', '09:00'), tueThu).toISOString()).toBe(ist('2026-10-22', '15:00').toISOString());
    expect(nextPickupSlot(ist('2026-10-22', '14:30'), tueThu).toISOString()).toBe(ist('2026-10-27', '15:00').toISOString());
    // Delhivery already failed to come today: tomorrow, even in the morning.
    expect(nextPickupSlot(ist('2026-10-21', '08:00'), undefined, { notToday: true }).toISOString()).toBe(ist('2026-10-22', '11:00').toISOString());
    // Sunday in the list, or nothing valid at all, never makes Sunday a pickup day.
    expect(nextPickupSlot(ist('2026-10-24', '15:00'), { slot: '11:00', days: [0] }).toISOString()).toBe(ist('2026-10-26', '11:00').toISOString());
  });
});

describe('shipping asks Delhivery to collect', () => {
  it('on the mock courier, collects at once: one request for the day, the parcel on its way', async () => {
    const ask = vi.spyOn(shippingProvider, 'requestPickup');
    const a = await confirmedOrder();
    const b = await confirmedOrder();
    expect((await call('PATCH', `/api/seller/orders/${a.ids[0]}/status`, { action: 'ship' })).status).toBe(200);
    expect((await call('PATCH', `/api/seller/orders/${b.ids[0]}/status`, { action: 'ship' })).status).toBe(200);
    // The second parcel joins the day's request: Delhivery is sent the new count for it, not a new request.
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0]![0]).toMatchObject({ warehouseName: `CLW-${sellerId}`, expectedPackages: 1 });
    expect(ask.mock.calls[0]![0].existingRequestId).toBeUndefined();
    const [pa, pb] = [await parcel(a.orderId), await parcel(b.orderId)];
    expect(pa.pickupRequestId).toMatch(/^MOCK-PU-/);
    expect(ask.mock.calls[1]![0]).toMatchObject({ expectedPackages: 2, existingRequestId: pa.pickupRequestId, pickupAt: pa.pickupScheduledFor });
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
