import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { shippingProvider } from '../services/shipping';
import { warehouseNameFor } from '../services/shipping/warehouses';
import { signAccessToken } from '../utils/jwt';

/**
 * Each seller's pickup address, registered with Delhivery under one fixed
 * name: at approval, again when the address changes, and at the first
 * booking as a backstop. Booking waits until it is registered, and says why.
 * Returns and RTO come back to the same address.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let buyerId: string;
let categoryId: string;
let seq = 0;
const sellers: string[] = [];
const orders: string[] = [];

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; error?: { message: string; code?: string } } };
}

/** A pending seller, with or without a business address. */
async function newSeller(address: { line1?: string; city?: string; state?: string; pincode?: string } | null) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `91966000${String(seq).padStart(2, '0')}`, name: `Warehouse Seller ${seq}`, role: Role.SELLER, referralCode: `WH-${seq}` },
  });
  const seller = await prisma.sellerProfile.create({
    data: {
      userId: user.id, shopName: `Warehouse Shop ${seq}`, status: SellerStatus.PENDING, gstNumber: '27ABCDE1234F1Z5', panName: 'WAREHOUSE TRADERS',
      ...(address ? { addressLine1: address.line1, city: address.city, state: address.state, pincode: address.pincode } : {}),
    },
  });
  sellers.push(seller.id);
  return { sellerId: seller.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

const DELHI = { line1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053' };
const profile = (id: string) => prisma.sellerProfile.findUniqueOrThrow({ where: { id } });

/** A confirmed one-line order of this seller's. */
async function order(sellerId: string) {
  seq += 1;
  const product = await prisma.product.create({
    data: { sellerId, categoryId, title: `WH Tee ${seq}`, slug: `wh-tee-${seq}`, description: 'For warehouse tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300 },
  });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: `SKU-WH-${seq}`, pricePaise: 50_000, stock: 5 } });
  const o = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-66${String(seq).padStart(4, '0')}`, status: 'CONFIRMED', subtotalPaise: 50_000, shippingPaise: 0, totalPaise: 50_000,
      shipName: 'WH Buyer', shipPhone: '9196600099', shipLine1: '1 Test Street', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
      items: { create: [{ productId: product.id, variantId: variant.id, sellerId, title: 'WH Tee', size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'CONFIRMED' }] },
    },
    include: { items: true },
  });
  orders.push(o.id);
  return o.items[0]!.id;
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { phone: '9196600098', name: 'WH Admin', role: Role.ADMIN, referralCode: 'WH-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  buyerId = (await prisma.user.create({ data: { phone: '9196600099', name: 'WH Buyer', referralCode: 'WH-B' } })).id;
  categoryId = (await prisma.category.create({ data: { name: 'WH Tees', slug: 'wh-tees', isActive: true } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('registering the pickup address', () => {
  it('happens at approval, under the seller’s fixed name, with returns to the same address', async () => {
    const upsert = vi.spyOn(shippingProvider, 'upsertWarehouse');
    const { sellerId, token } = await newSeller(DELHI);
    const r = await call('PATCH', `/api/admin/sellers/${sellerId}/status`, adminToken, { action: 'approve', acknowledgeKycWarnings: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await profile(sellerId)).toMatchObject({
      courierWarehouseStatus: 'ACTIVE',
      courierWarehouseName: warehouseNameFor(sellerId),
      courierWarehouseError: null,
    });
    expect(warehouseNameFor(sellerId)).not.toContain('_');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: warehouseNameFor(sellerId),
        registeredName: 'WAREHOUSE TRADERS',
        address: { line1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053' },
        returnAddress: { line1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053' },
      }),
    );
    // The seller sees it in Store Settings.
    const store = await call('GET', '/api/seller/store', token);
    expect((store.json.data as { settings?: { courierWarehouse: unknown } }).settings?.courierWarehouse ?? store.json.data.courierWarehouse).toMatchObject({ status: 'ACTIVE' });
    upsert.mockRestore();
  });

  it('is sent again when the pickup address changes, and only then', async () => {
    const { sellerId, token } = await newSeller(DELHI);
    await call('PATCH', `/api/admin/sellers/${sellerId}/status`, adminToken, { action: 'approve', acknowledgeKycWarnings: true });
    const upsert = vi.spyOn(shippingProvider, 'upsertWarehouse');
    const same = { pickupSameAsBusiness: true, dispatchDays: 2, codEnabled: true };
    await call('PUT', '/api/seller/store/shipping', token, same);
    expect(upsert).not.toHaveBeenCalled();
    const moved = { pickupSameAsBusiness: false, pickupLine1: '9 New Godown Lane', pickupCity: 'Delhi', pickupState: 'Delhi', pickupPincode: '110092', dispatchDays: 2, codEnabled: true };
    const r = await call('PUT', '/api/seller/store/shipping', token, moved);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0]).toMatchObject({ name: warehouseNameFor(sellerId), address: { line1: '9 New Godown Lane', pincode: '110092' } });
    expect((await profile(sellerId)).courierWarehouseStatus).toBe('ACTIVE');
    upsert.mockRestore();
  });

  it('records why it failed, and booking waits for it with that reason', async () => {
    // Delhivery doesn't pick up at 999999 (the mock's unserved pincode).
    const { sellerId, token } = await newSeller({ ...DELHI, pincode: '999999' });
    await call('PATCH', `/api/admin/sellers/${sellerId}/status`, adminToken, { action: 'approve', acknowledgeKycWarnings: true });
    const p = await profile(sellerId);
    expect(p.status).toBe('APPROVED'); // approval itself never waits on the courier
    expect(p.courierWarehouseStatus).toBe('FAILED');
    expect(p.courierWarehouseError).toMatch(/^Delhivery: Pickup is not available at pincode 999999/);
    const line = await order(sellerId);
    const r = await call('PATCH', `/api/seller/orders/${line}/status`, token, { action: 'assign' });
    expect(r.status).toBe(400);
    expect(r.json.error?.message).toMatch(/^Your pickup address isn't registered with Delhivery yet — Delhivery: .*999999/);
    expect(await prisma.shipment.count({ where: { sellerId } })).toBe(0);
  });

  it('asks for what is missing, and registers at the first booking once it is there', async () => {
    const { sellerId, token } = await newSeller(null);
    await call('PATCH', `/api/admin/sellers/${sellerId}/status`, adminToken, { action: 'approve', acknowledgeKycWarnings: true });
    expect((await profile(sellerId)).courierWarehouseError).toMatch(/street address, city, state, 6-digit PIN code missing/);
    // The address arrives without going through the store form (an admin edit, say).
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { addressLine1: DELHI.line1, city: DELHI.city, state: DELHI.state, pincode: DELHI.pincode } });
    const line = await order(sellerId);
    const r = await call('PATCH', `/api/seller/orders/${line}/status`, token, { action: 'assign' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await profile(sellerId)).courierWarehouseStatus).toBe('ACTIVE');
    expect(await prisma.shipment.count({ where: { sellerId } })).toBe(1);
  });

  it('can be retried by an admin, and shows on the admin’s seller page', async () => {
    const { sellerId } = await newSeller({ ...DELHI, pincode: '999999' });
    await call('PATCH', `/api/admin/sellers/${sellerId}/status`, adminToken, { action: 'approve', acknowledgeKycWarnings: true });
    const detail = await call('GET', `/api/admin/sellers/${sellerId}`, adminToken);
    expect(detail.json.data.courierWarehouse).toMatchObject({ status: 'FAILED' });
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { pincode: '110053' } });
    const retry = await call('POST', `/api/admin/sellers/${sellerId}/courier-warehouse`, adminToken);
    expect(retry.json.data).toMatchObject({ status: 'ACTIVE', name: warehouseNameFor(sellerId), error: null });
  });
});

describe('the return address', () => {
  it('is where parcels go back to when set: RTO by the warehouse’s return address, returns by a second warehouse there', async () => {
    const { sellerId, token } = await newSeller(DELHI);
    await call('PATCH', `/api/admin/sellers/${sellerId}/status`, adminToken, { action: 'approve', acknowledgeKycWarnings: true });
    const upsert = vi.spyOn(shippingProvider, 'upsertWarehouse');
    const r = await call('PUT', '/api/seller/store/returns', token, {
      returnAddressSameAsPickup: false, returnLine1: '12 Returns Lane', returnCity: 'Noida', returnState: 'Uttar Pradesh', returnPincode: '201301',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const returnTo = { line1: '12 Returns Lane', city: 'Noida', state: 'Uttar Pradesh', pincode: '201301' };
    expect(upsert.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ name: warehouseNameFor(sellerId), address: expect.objectContaining({ pincode: '110053' }), returnAddress: returnTo }),
      expect.objectContaining({ name: `${warehouseNameFor(sellerId)}-R`, address: returnTo, returnAddress: returnTo }),
    ]);
    expect(await profile(sellerId)).toMatchObject({ courierWarehouseStatus: 'ACTIVE', courierReturnWarehouseName: `${warehouseNameFor(sellerId)}-R` });
    upsert.mockRestore();
  });

  it('falls back to the pickup address when not set, and says what is missing when half filled in', async () => {
    const { sellerId, token } = await newSeller(DELHI);
    await call('PATCH', `/api/admin/sellers/${sellerId}/status`, adminToken, { action: 'approve', acknowledgeKycWarnings: true });
    expect(await profile(sellerId)).toMatchObject({ courierReturnWarehouseName: null });
    await call('PUT', '/api/seller/store/returns', token, { returnAddressSameAsPickup: false, returnLine1: '12 Returns Lane' });
    const p = await profile(sellerId);
    expect(p.courierWarehouseStatus).toBe('FAILED');
    expect(p.courierWarehouseError).toMatch(/return address.*city, state, 6-digit PIN code missing/);
    // Back to "same as pickup": registered again, no return warehouse.
    await call('PUT', '/api/seller/store/returns', token, { returnAddressSameAsPickup: true });
    expect(await profile(sellerId)).toMatchObject({ courierWarehouseStatus: 'ACTIVE', courierReturnWarehouseName: null });
  });
});
