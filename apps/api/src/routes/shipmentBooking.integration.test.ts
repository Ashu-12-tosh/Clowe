import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';
import { invalidateCategoryRules } from '../services/categoryRules';

/**
 * Booking with Delhivery (the mock here). Delhivery is the only courier, so
 * there is nothing to choose: "assign" books the seller's lines of an order
 * as one parcel (a Shipment row) and the lines carry its AWB for the label.
 * Booking needs no packing video; it happens once per line; "ship" sends the
 * parcel already booked, or books one. The COD a parcel collects is its
 * lines' share of what the buyer owes, so separate parcels add up to the
 * order total.
 */

const prisma = new PrismaClient();
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
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; error?: { message: string; code?: string } } };
}

/** A confirmed order of ours, by default one ₹500 line, optionally with its packing clip. */
async function confirmedOrder(opts: {
  withClip?: boolean;
  lines?: { pricePaise: number; quantity?: number; promoDiscountPaise?: number }[];
  totalPaise?: number;
  cod?: boolean;
  pincode?: string;
} = {}) {
  seq += 1;
  const lines = opts.lines ?? [{ pricePaise: 50_000 }];
  const subtotal = lines.reduce((sum, l) => sum + l.pricePaise * (l.quantity ?? 1), 0);
  const total = opts.totalPaise ?? subtotal;
  const order = await prisma.order.create({
    data: {
      userId: buyerId,
      orderNumber: `CLW-2026-77${String(seq).padStart(4, '0')}`,
      status: 'CONFIRMED',
      subtotalPaise: subtotal,
      shippingPaise: 0,
      totalPaise: total,
      paymentMethod: opts.cod ? 'COD' : 'UPI',
      shipName: 'Booking Buyer',
      shipPhone: '9198900002',
      shipLine1: '1 Test Street',
      shipCity: 'Pune',
      shipState: 'Maharashtra',
      shipPincode: opts.pincode ?? '411001',
      payment: { create: { provider: 'mock', amountPaise: total, status: opts.cod ? 'CREATED' : 'PAID' } },
      items: {
        create: lines.map((l, i) => ({
          productId, variantId, sellerId, title: `Booking Tee ${i + 1}`, size: '', color: '', pricePaise: l.pricePaise,
          quantity: l.quantity ?? 1, promoDiscountPaise: l.promoDiscountPaise ?? 0, status: 'CONFIRMED' as const,
        })),
      },
    },
    include: { items: { orderBy: { title: 'asc' } } },
  });
  orders.push(order.id);
  if (opts.withClip) await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId, fileRef: 'asset:test' } });
  return { orderId: order.id, ids: order.items.map((i) => i.id) };
}

const line = (id: string) => prisma.orderItem.findUniqueOrThrow({ where: { id }, include: { shipment: true } });

beforeAll(async () => {
  const user = await prisma.user.create({ data: { phone: '9198900001', name: 'Booking Seller', role: Role.SELLER, referralCode: 'ASN-S' } });
  const seller = await prisma.sellerProfile.create({
    data: {
      userId: user.id, shopName: 'Booking Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
      addressLine1: '5 Seller Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001',
    },
  });
  sellerId = seller.id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  const admin = await prisma.user.create({ data: { phone: '9198900003', name: 'Booking Admin', role: Role.ADMIN, referralCode: 'ASN-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  buyerId = (await prisma.user.create({ data: { phone: '9198900002', name: 'Booking Buyer', referralCode: 'ASN-B' } })).id;
  const category = await prisma.category.create({ data: { name: 'Booking Tees', slug: 'booking-tees', isActive: true } });
  const product = await prisma.product.create({
    data: {
      sellerId, categoryId: category.id, title: 'Booking Tee', slug: 'booking-tee', description: 'For shipment booking tests.',
      basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300, lengthMm: 300, widthMm: 250, heightMm: 30,
    },
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

describe('booking with Delhivery', () => {
  it('books a parcel without shipping, needs no packing video, and the line carries its AWB', async () => {
    const { ids: [id] } = await confirmedOrder();
    const r = await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const after = await line(id!);
    expect(after).toMatchObject({ status: 'CONFIRMED', courierName: 'Delhivery', shippedAt: null });
    expect(after.shipment).toMatchObject({
      kind: 'FORWARD', provider: 'mock', environment: 'mock', status: 'CREATED', paymentType: 'PREPAID', codAmountPaise: 0,
      mode: 'SURFACE', weightGrams: 300, lengthMm: 300, widthMm: 250, heightMm: 30, awbNumber: after.awbNumber,
    });
    expect(after.awbNumber).toMatch(/^AWB/);
    expect(after.shipment!.estimatedFreightPaise).toBeGreaterThan(0);
  });

  it('happens once: booking again is refused and the AWB stays', async () => {
    const { ids: [id] } = await confirmedOrder();
    await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign' });
    const first = await line(id!);
    const r = await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign' });
    expect(r.status).toBe(400);
    expect(r.json.error!.message).toContain(first.awbNumber!);
    expect((await line(id!)).awbNumber).toBe(first.awbNumber);
    expect(await prisma.shipment.count({ where: { orderId: first.orderId } })).toBe(1);
  });

  it('ignores a courier name sent by an old screen: Delhivery is the only courier', async () => {
    const { ids: [id] } = await confirmedOrder();
    await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign', courier: 'BlueDart' });
    expect((await line(id!)).courierName).toBe('Delhivery');
  });

  it('is what ships: the parcel booked is the one that goes', async () => {
    const { ids: [id] } = await confirmedOrder({ withClip: true });
    await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign' });
    const booked = await line(id!);
    const r = await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'ship' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const shipped = await line(id!);
    expect(shipped).toMatchObject({ status: 'SHIPPED', awbNumber: booked.awbNumber, shipmentId: booked.shipmentId });
    expect(shipped.shippedAt).not.toBeNull();
    expect(shipped.shipment).toMatchObject({ status: 'IN_TRANSIT' });
    expect(shipped.shipment!.pickedUpAt).not.toBeNull();
  });

  it('ships a line not booked yet by booking it then, and refuses booking once shipped', async () => {
    const { ids: [id] } = await confirmedOrder({ withClip: true });
    const r = await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'ship' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const shipped = await line(id!);
    expect(shipped).toMatchObject({ status: 'SHIPPED', courierName: 'Delhivery' });
    expect(shipped.shipment!.awbNumber).toBe(shipped.awbNumber);
    expect((await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign' })).status).toBe(400);
  });

  it('does not ship without the packing video, and books nothing then', async () => {
    const { ids: [id] } = await confirmedOrder();
    const r = await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'ship' });
    expect(r.status).toBe(400);
    expect(await line(id!)).toMatchObject({ status: 'CONFIRMED', shipmentId: null, awbNumber: null });
  });

  it('marks the parcel delivered once every live line in it is, and settles COD as before', async () => {
    const { orderId, ids } = await confirmedOrder({ withClip: true, cod: true, lines: [{ pricePaise: 30_000 }, { pricePaise: 20_000 }] });
    const bulk = await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'ship' });
    expect(bulk.json.data).toMatchObject({ updated: 2, skipped: [] });
    const [a, b] = await Promise.all(ids.map(line));
    expect(a!.shipmentId).toBe(b!.shipmentId);
    await call('PATCH', `/api/seller/orders/${ids[0]}/status`, { action: 'deliver' });
    expect((await line(ids[0]!)).shipment!.status).toBe('IN_TRANSIT');
    await call('PATCH', `/api/seller/orders/${ids[1]}/status`, { action: 'deliver' });
    const done = await line(ids[1]!);
    expect(done.shipment).toMatchObject({ status: 'DELIVERED' });
    expect(done.shipment!.deliveredAt).not.toBeNull();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true } });
    expect(order.status).toBe('DELIVERED');
    expect(order.payment!.status).toBe('PAID');
  });

  it('refuses a pincode Delhivery does not serve, and leaves nothing booked', async () => {
    const { orderId, ids: [id] } = await confirmedOrder({ pincode: '999999' });
    const r = await call('PATCH', `/api/seller/orders/${id}/status`, { action: 'assign' });
    expect(r.status).toBe(400);
    expect(r.json.error!.message).toMatch(/^Delhivery: .*999999/);
    expect(await line(id!)).toMatchObject({ shipmentId: null, awbNumber: null, courierName: null });
    expect(await prisma.shipment.count({ where: { orderId } })).toBe(0);
  });
});

describe('parcels and money', () => {
  it('books the lines of one order picked together as one parcel, and separate orders separately', async () => {
    const one = await confirmedOrder({ lines: [{ pricePaise: 30_000 }, { pricePaise: 20_000, quantity: 2 }] });
    const two = await confirmedOrder();
    const r = await call('POST', '/api/seller/orders/bulk', { itemIds: [...one.ids, ...two.ids], action: 'assign' });
    expect(r.json.data).toMatchObject({ updated: 3, skipped: [] });
    const parcels = await prisma.shipment.findMany({ where: { orderId: { in: [one.orderId, two.orderId] } }, include: { items: true } });
    expect(parcels.map((p) => p.items.length).sort()).toEqual([1, 2]);
    const box = parcels.find((p) => p.orderId === one.orderId)!;
    // 300 g × 1 + 300 g × 2; several units go in a box whose size is confirmed later.
    expect(box).toMatchObject({ weightGrams: 900, lengthMm: null });
    const detail = await call('GET', `/api/seller/orders/${one.orderId}`);
    const lines = detail.json.data.lines as Array<{ canAssign: boolean; shipmentId: string | null; courierName: string }>;
    expect(lines.every((l) => !l.canAssign && l.shipmentId === box.id && l.courierName === 'Delhivery')).toBe(true);
  });

  it('collects on each COD parcel its lines’ share of what the buyer owes, adding up to the order total', async () => {
    // ₹600 + ₹400 (less a ₹100 promotion) = ₹900 of goods; with delivery and a coupon the buyer owes ₹865.
    const { orderId, ids } = await confirmedOrder({
      cod: true, totalPaise: 86_500, lines: [{ pricePaise: 30_000, quantity: 2 }, { pricePaise: 40_000, promoDiscountPaise: 10_000 }],
    });
    await call('PATCH', `/api/seller/orders/${ids[0]}/status`, { action: 'assign' });
    await call('PATCH', `/api/seller/orders/${ids[1]}/status`, { action: 'assign' });
    const parcels = await prisma.shipment.findMany({ where: { orderId }, include: { items: { select: { id: true } } } });
    expect(parcels).toHaveLength(2);
    const cod = (itemId: string) => parcels.find((p) => p.items[0]!.id === itemId)!.codAmountPaise;
    expect(cod(ids[0]!)).toBe(57_667);
    expect(cod(ids[1]!)).toBe(28_833);
    expect(cod(ids[0]!) + cod(ids[1]!)).toBe(86_500);
    expect(parcels.every((p) => p.paymentType === 'COD')).toBe(true);
  });

  it('prints one label per parcel, listing every line in the box and its COD', async () => {
    const { ids } = await confirmedOrder({ cod: true, totalPaise: 56_000, lines: [{ pricePaise: 30_000 }, { pricePaise: 20_000 }] });
    await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'assign' });
    const res = await call('GET', `/api/seller/orders/labels?ids=${ids[0]}`);
    const labels = res.json.data as unknown as Array<Record<string, unknown>>;
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      courierName: 'Delhivery', isCod: true, codAmountPaise: 56_000, mode: 'SURFACE', weightGrams: 600,
      orderItemIds: expect.arrayContaining(ids), sortCode: expect.stringMatching(/^MOCK\//),
      shipFrom: expect.objectContaining({ line1: '5 Seller Road', pincode: '400001' }),
    });
    expect((labels[0]!.contents as unknown[]).length).toBe(2);

    // A line not booked yet: its own label, its own share, no AWB.
    const loose = await confirmedOrder({ cod: true, totalPaise: 56_000 });
    const single = (await call('GET', `/api/seller/orders/labels?ids=${loose.ids[0]}`)).json.data as unknown as Array<Record<string, unknown>>;
    expect(single[0]).toMatchObject({ awbNumber: null, courierName: null, codAmountPaise: 56_000, key: loose.ids[0] });
  });

  it('prints each line’s HSN code and the declared value the courier is told', async () => {
    const { ids } = await confirmedOrder({ cod: false, totalPaise: 56_000, lines: [{ pricePaise: 30_000 }, { pricePaise: 20_000 }] });
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: ids[0]! }, select: { product: { select: { categoryId: true } } } });
    const category = await prisma.category.findUniqueOrThrow({ where: { id: item.product.categoryId }, select: { hsnCode: true } });
    await prisma.category.update({ where: { id: item.product.categoryId }, data: { hsnCode: '6109' } });
    invalidateCategoryRules();
    try {
      await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'assign' });
      const labels = (await call('GET', `/api/seller/orders/labels?ids=${ids[0]}`)).json.data as unknown as Array<{
        declaredValuePaise: number;
        isCod: boolean;
        contents: { hsnCode: string | null }[];
      }>;
      // Prepaid: nothing to collect, but the goods are still worth what was paid.
      expect(labels[0]).toMatchObject({ isCod: false, declaredValuePaise: 56_000 });
      expect(labels[0]!.contents.map((l) => l.hsnCode)).toEqual(['6109', '6109']);
      // …and the parcel itself collects nothing.
      const parcel = await prisma.shipment.findFirstOrThrow({ where: { items: { some: { id: ids[0]! } } } });
      expect(parcel.codAmountPaise).toBe(0);
    } finally {
      await prisma.category.update({ where: { id: item.product.categoryId }, data: { hsnCode: category.hsnCode } });
      invalidateCategoryRules();
    }
  });

  it('shows Surface and Express parcels on the summary, with no courier list', async () => {
    const res = await call('GET', '/api/seller/orders/summary');
    expect(res.json.data).not.toHaveProperty('couriers');
    expect(res.json.data).not.toHaveProperty('topCouriers');
    const modes = res.json.data.shippingModes as Array<{ mode: string; label: string; count: number; share: number }>;
    expect(modes.find((m) => m.mode === 'SURFACE')).toMatchObject({ label: 'Surface', share: 100 });
  });

  it('an AWB typed at the admin desk is Delhivery’s, and never overwrites a booked parcel’s', async () => {
    const loose = await confirmedOrder({ withClip: true });
    const r = await call('PATCH', `/api/admin/orders/${loose.orderId}/status`, { status: 'SHIPPED', trackingNumber: 'DLV123', courier: 'DTDC' }, adminToken);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await line(loose.ids[0]!)).toMatchObject({ status: 'SHIPPED', awbNumber: 'DLV123', courierName: 'Delhivery' });

    const booked = await confirmedOrder({ withClip: true });
    await call('PATCH', `/api/seller/orders/${booked.ids[0]}/status`, { action: 'assign' });
    const before = await line(booked.ids[0]!);
    await call('PATCH', `/api/admin/orders/${booked.orderId}/status`, { status: 'SHIPPED', trackingNumber: 'DLV999' }, adminToken);
    const after = await line(booked.ids[0]!);
    expect(after).toMatchObject({ status: 'SHIPPED', awbNumber: before.awbNumber });
    expect(after.shipment!.status).toBe('IN_TRANSIT');
  });
});

describe('the box, as the seller confirms it', () => {
  it('is priced as typed, on the greater of its weight and volumetric weight', async () => {
    const { orderId, ids } = await confirmedOrder({ lines: [{ pricePaise: 30_000 }, { pricePaise: 20_000 }] });
    const suggested = await call('POST', '/api/seller/orders/booking-quote', { itemIds: ids });
    // Two products in one box: the weight is theirs, the box size is the seller's to give.
    expect((suggested.json.data.parcels as unknown[])[0]).toMatchObject({ weightGrams: 600, lengthMm: null, widthMm: null, heightMm: null, chargeableGrams: 600 });
    const box = { weightGrams: 900, lengthMm: 400, widthMm: 300, heightMm: 200 }; // 4.8 kg volumetric
    const typed = await call('POST', '/api/seller/orders/booking-quote', { itemIds: ids, boxes: { [orderId]: box } });
    expect((typed.json.data.parcels as unknown[])[0]).toMatchObject({ ...box, chargeableGrams: 4_800 });
  });

  it('is what gets booked, and a box that makes no sense is refused', async () => {
    const { orderId, ids } = await confirmedOrder({ lines: [{ pricePaise: 30_000 }, { pricePaise: 20_000 }] });
    const bad = await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'assign', boxes: { [orderId]: { weightGrams: 0, lengthMm: 300, widthMm: 200, heightMm: 100 } } });
    expect(bad.status).toBe(400);
    expect(await prisma.shipment.count({ where: { orderId } })).toBe(0);
    const box = { weightGrams: 1_250, lengthMm: 350, widthMm: 250, heightMm: 120 };
    const r = await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'assign', boxes: { [orderId]: box } });
    expect(r.json.data).toMatchObject({ updated: 2, skipped: [] });
    expect(await prisma.shipment.findFirstOrThrow({ where: { orderId } })).toMatchObject(box);
  });

  it('puts the courier’s destination hub on the label', async () => {
    const { ids } = await confirmedOrder();
    await call('POST', '/api/seller/orders/bulk', { itemIds: ids, action: 'assign' });
    const labels = (await call('GET', `/api/seller/orders/labels?ids=${ids[0]}`)).json.data as unknown as Array<Record<string, unknown>>;
    expect(labels[0]).toMatchObject({ destinationHub: 'Pune (mock hub)', sortCode: expect.stringMatching(/^MOCK\//) });
  });
});
