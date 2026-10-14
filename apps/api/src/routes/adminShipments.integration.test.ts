import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * The admin's parcels desk: what needs someone first — failed attempts, lost
 * parcels, parcels coming back or back and unchecked, bookings not collected
 * in two days — then every parcel by status, searchable by AWB, order or shop.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let sellerToken: string;
let sellerId: string;
let orderId: string;
const ids: Record<string, string> = {};

async function get(path: string, token = adminToken) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as { data: { rows: { awbNumber: string; status: string }[]; total: number; provider: string } } };
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { phone: '9190900003', name: 'Desk Admin', role: Role.ADMIN, referralCode: 'DSK-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const user = await prisma.user.create({ data: { phone: '9190900001', name: 'Desk Seller', role: Role.SELLER, referralCode: 'DSK-S' } });
  sellerToken = signAccessToken({ sub: user.id, role: 'SELLER' });
  sellerId = (await prisma.sellerProfile.create({ data: { userId: user.id, shopName: 'Desk Shop', status: SellerStatus.APPROVED, approvedAt: new Date() } })).id;
  const buyer = await prisma.user.create({ data: { phone: '9190900002', name: 'Desk Buyer', referralCode: 'DSK-B' } });
  orderId = (
    await prisma.order.create({
      data: {
        userId: buyer.id, orderNumber: 'CLW-2026-990901', status: 'SHIPPED', subtotalPaise: 50_000, shippingPaise: 0, totalPaise: 50_000,
        shipName: 'Desk Buyer', shipPhone: '9190900002', shipLine1: '1 Test Street', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
      },
    })
  ).id;
  const old = new Date(Date.now() - 3 * 86_400_000);
  for (const [awb, status, createdAt] of [
    ['DSK-FAILED', 'DELIVERY_FAILED', new Date()],
    ['DSK-LOST', 'LOST', new Date()],
    ['DSK-STALE', 'PICKUP_REQUESTED', old],
    ['DSK-FRESH', 'CREATED', new Date()],
    ['DSK-MOVING', 'IN_TRANSIT', new Date()],
    ['DSK-DONE', 'DELIVERED', new Date()],
  ] as const) {
    ids[awb] = (
      await prisma.shipment.create({
        data: { orderId, sellerId, provider: 'mock', environment: 'mock', awbNumber: awb, paymentType: 'PREPAID', weightGrams: 500, status, createdAt },
      })
    ).id;
  }
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: orderId } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the parcels desk', () => {
  it('puts failed, lost and long-uncollected parcels first, and nothing that is fine', async () => {
    const r = await get('/api/admin/shipments?q=DSK-');
    expect(r.status).toBe(200);
    expect(r.json.data.rows.map((x) => x.awbNumber).sort()).toEqual(['DSK-FAILED', 'DSK-LOST', 'DSK-STALE']);
    expect(r.json.data.provider).toBe('mock');
  });

  it('lists by status, and finds a parcel by AWB, order or shop', async () => {
    expect((await get('/api/admin/shipments?filter=IN_TRANSIT&q=DSK-')).json.data.rows.map((x) => x.awbNumber)).toEqual(['DSK-MOVING']);
    expect((await get('/api/admin/shipments?filter=ALL&q=CLW-2026-990901')).json.data.total).toBe(6);
    expect((await get('/api/admin/shipments?filter=ALL&q=Desk Shop')).json.data.total).toBe(6);
    expect((await get('/api/admin/shipments?filter=ALL&q=DSK-DONE')).json.data.rows.map((x) => x.status)).toEqual(['DELIVERED']);
  });

  it('is for admins only', async () => {
    expect((await get('/api/admin/shipments', sellerToken)).status).toBe(403);
  });
});
