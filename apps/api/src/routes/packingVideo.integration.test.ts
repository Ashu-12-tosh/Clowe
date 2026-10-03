import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKING_VIDEO_REQUIRED_MESSAGE, PACKING_VIDEO_RETENTION_DAYS, type PackingVideoView, type SellerOrderRow } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { sweepExpiredPackingVideos } from '../services/packingVideos';
import { storePrivateFile } from '../services/assets';

/**
 * The packing video belongs to the order now: required before dispatch,
 * private to the seller and admins, and kept until 45 days after delivery
 * and while a return is open.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
let adminToken: string;
let seq = 0;
const DAY = 24 * 60 * 60 * 1000;
// The start of an MP4: a box size, then "ftyp".
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);

beforeAll(async () => {
  await seedFixture(prisma);
  categoryId = (await prisma.category.findFirstOrThrow({ where: { isActive: true } })).id;
  const admin = await prisma.user.create({ data: { phone: '9150000000', name: 'Pack Admin', role: Role.ADMIN, referralCode: 'PACK-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { data?: never; error?: { code: string; message: string } } };
}

async function seller() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `91510${String(seq).padStart(5, '0')}`, name: `Pack Seller ${seq}`, role: Role.SELLER, referralCode: `PACK-S-${seq}` },
  });
  const profile = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Pack Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  const product = await prisma.product.create({
    data: {
      sellerId: profile.id, categoryId, title: `Packed ${seq}`, slug: `packed-${seq}`, description: 'Packing test listing.',
      basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), packingVideoUrl: 'asset:a-listing-clip',
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, optionValues: {}, sku: `PACK-${seq}`, pricePaise: 50_000, stock: 20 },
  });
  return { userId: user.id, sellerId: profile.id, product, variant, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

async function shopper() {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91520${String(seq).padStart(5, '0')}`, name: 'Pack Buyer', referralCode: `PACK-U-${seq}` } });
  return { id: user.id, token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }) };
}

type Seller = Awaited<ReturnType<typeof seller>>;

async function order(s: Seller, buyerId: string, status: 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' = 'CONFIRMED', deliveredAt?: Date) {
  seq += 1;
  const o = await prisma.order.create({
    data: {
      orderNumber: `CLW-PACK-${seq}`, userId: buyerId, shipName: 'B', shipPhone: '9152000000', shipLine1: '1 Lane', shipCity: 'Pune',
      shipState: 'Maharashtra', shipPincode: '411001', status, subtotalPaise: 50_000, totalPaise: 50_000, paymentMethod: 'UPI',
    },
  });
  const item = await prisma.orderItem.create({
    data: {
      orderId: o.id, productId: s.product.id, variantId: s.variant.id, sellerId: s.sellerId, title: 'packed', size: '', color: '',
      pricePaise: 50_000, quantity: 1, status, deliveredAt: deliveredAt ?? (status === 'DELIVERED' ? new Date() : null),
    },
  });
  return { orderId: o.id, itemId: item.id };
}

async function uploadClip(token: string): Promise<string> {
  const form = new FormData();
  form.append('video', new Blob([MP4], { type: 'video/mp4' }), 'pack.mp4');
  const res = await fetch(`${base}/api/uploads/video`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return ((await res.json()) as { data: { ref: string } }).data.ref;
}

describe('dispatch', () => {
  it('is refused without the packing video, and allowed once it is recorded', async () => {
    const s = await seller();
    const buyer = await shopper();
    const { orderId, itemId } = await order(s, buyer.id);

    const refused = await call('PATCH', `/api/seller/orders/${itemId}/status`, s.token, { action: 'ship' });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toEqual({ code: 'PACKING_VIDEO_REQUIRED', message: PACKING_VIDEO_REQUIRED_MESSAGE });
    const bulk = await call('POST', '/api/seller/orders/bulk', s.token, { itemIds: [itemId], action: 'ship' });
    expect(bulk.json.data).toEqual({ updated: 0, skipped: [{ itemId, reason: PACKING_VIDEO_REQUIRED_MESSAGE }] });
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('CONFIRMED');

    const ref = await uploadClip(s.token);
    const attached = await call('POST', `/api/seller/orders/${orderId}/packing-video`, s.token, { ref });
    expect(attached.status).toBe(200);
    expect((attached.json.data as unknown as PackingVideoView).url).toContain('/api/files/local?');

    const shipped = await call('PATCH', `/api/seller/orders/${itemId}/status`, s.token, { action: 'ship' });
    expect(shipped.status).toBe(200);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('SHIPPED');
  });

  it('gates "Mark packed" and "Mark all packed" the same way', async () => {
    const s = await seller();
    const buyer = await shopper();
    const { orderId, itemId } = await order(s, buyer.id);

    const refused = await call('PATCH', `/api/seller/orders/${itemId}/status`, s.token, { action: 'pack' });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toEqual({ code: 'PACKING_VIDEO_REQUIRED', message: PACKING_VIDEO_REQUIRED_MESSAGE });
    const bulk = await call('POST', '/api/seller/orders/bulk', s.token, { itemIds: [itemId], action: 'pack' });
    expect(bulk.json.data).toEqual({ updated: 0, skipped: [{ itemId, reason: PACKING_VIDEO_REQUIRED_MESSAGE }] });
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('CONFIRMED');

    const ref = await uploadClip(s.token);
    expect((await call('POST', `/api/seller/orders/${orderId}/packing-video`, s.token, { ref })).status).toBe(200);
    const packed = await call('POST', '/api/seller/orders/bulk', s.token, { itemIds: [itemId], action: 'pack' });
    expect(packed.json.data).toEqual({ updated: 1, skipped: [] });
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('PACKED');
  });

  it('lets an admin mark packed or shipped without the clip only with a reason, on the audit log', async () => {
    const s = await seller();
    const buyer = await shopper();
    const { orderId, itemId } = await order(s, buyer.id);
    const move = (body: Record<string, unknown>) => call('PATCH', `/api/admin/orders/${orderId}/status`, adminToken, body);
    const { shopName } = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.sellerId } });

    for (const status of ['PACKED', 'SHIPPED', 'DELIVERED']) {
      const refused = await move({ status });
      expect(refused.status).toBe(400);
      expect(refused.json.error?.code).toBe('PACKING_VIDEO_REQUIRED');
      expect(refused.json.error?.message).toContain(shopName);
    }
    expect((await move({ status: 'PACKED', noClipReason: 'abc' })).status).toBe(400); // too short to explain anything
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('CONFIRMED');

    const reason = 'Seller packed on a video call with support';
    expect((await move({ status: 'PACKED', noClipReason: reason })).status).toBe(200);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe('PACKED');
    await new Promise((r) => setTimeout(r, 200));
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'Packing video overridden', entityId: orderId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toMatchObject({ module: 'ORDERS', severity: 'HIGH' });
    expect(audit?.metadata).toMatchObject({ status: 'PACKED', reason, sellerIds: [s.sellerId], itemIds: [itemId] });

    // With the clip recorded, no reason is asked for and nothing is overridden.
    const ref = await uploadClip(s.token);
    expect((await call('POST', `/api/seller/orders/${orderId}/packing-video`, s.token, { ref })).status).toBe(200);
    expect((await move({ status: 'SHIPPED' })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'Packing video overridden', entityId: orderId } })).toBe(1);
  });

  it("takes only the seller's own upload, and no swap once something has shipped", async () => {
    const s = await seller();
    const other = await seller();
    const buyer = await shopper();
    const { orderId, itemId } = await order(s, buyer.id);
    const theirs = await uploadClip(other.token);
    const stolen = await call('POST', `/api/seller/orders/${orderId}/packing-video`, s.token, { ref: theirs });
    expect(stolen.json.error?.code).toBe('INVALID_FILE');
    // Another seller cannot attach to an order that is not theirs.
    const elsewhere = await call('POST', `/api/seller/orders/${orderId}/packing-video`, other.token, { ref: theirs });
    expect(elsewhere.status).toBe(404);

    await call('POST', `/api/seller/orders/${orderId}/packing-video`, s.token, { ref: await uploadClip(s.token) });
    await call('PATCH', `/api/seller/orders/${itemId}/status`, s.token, { action: 'ship' });
    const swap = await call('POST', `/api/seller/orders/${orderId}/packing-video`, s.token, { ref: await uploadClip(s.token) });
    expect(swap.json.error?.code).toBe('PACKING_VIDEO_LOCKED');
  });
});

describe('who sees it', () => {
  it('shows the seller and admins on the order and the return, never the buyer', async () => {
    const s = await seller();
    const buyer = await shopper();
    const { orderId, itemId } = await order(s, buyer.id);
    await call('POST', `/api/seller/orders/${orderId}/packing-video`, s.token, { ref: await uploadClip(s.token) });
    await prisma.orderItem.update({ where: { id: itemId }, data: { status: 'RETURN_REQUESTED', deliveredAt: new Date() } });
    const ret = await prisma.return.create({
      data: { rmaNumber: `RMA-PACK-${seq}`, orderItemId: itemId, userId: buyer.id, reason: 'Not as shown', status: 'REQUESTED' },
    });

    const sellerOrder = await call('GET', `/api/seller/orders/${orderId}`, s.token);
    expect((sellerOrder.json.data as unknown as SellerOrderRow).packingVideo?.url).toContain('/api/files/local?');
    const sellerReturn = await call('GET', `/api/seller/returns/${ret.id}`, s.token);
    expect((sellerReturn.json.data as unknown as { packingVideo: PackingVideoView }).packingVideo.url).toContain('/api/files/local?');
    const adminReturn = await call('GET', `/api/admin/returns/${ret.id}`, adminToken);
    expect((adminReturn.json.data as unknown as { packingVideo: PackingVideoView }).packingVideo.url).toContain('/api/files/local?');

    const buyerOrder = await call('GET', `/api/orders/${orderId}`, buyer.token);
    expect(buyerOrder.status).toBe(200);
    expect(buyerOrder.text).not.toMatch(/packing/i);
    const clip = await prisma.orderPackingVideo.findFirstOrThrow({ where: { orderId } });
    expect(buyerOrder.text).not.toContain(clip.fileRef.slice('asset:'.length));
  });
});

describe('retention', () => {
  it('keeps a clip until 45 days after delivery, and while a return is open or anything is still on its way', async () => {
    const s = await seller();
    const buyer = await shopper();
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * DAY);
    const clipFor = async (orderId: string, uploadedDaysAgo: number) => {
      const stored = await storePrivateFile({ purpose: 'PACKING_VIDEO', ownerId: s.userId, body: MP4, contentType: 'video/mp4' });
      return prisma.orderPackingVideo.create({ data: { orderId, sellerId: s.sellerId, fileRef: stored.ref, uploadedAt: ago(uploadedDaysAgo) } });
    };
    const margin = PACKING_VIDEO_RETENTION_DAYS;

    const recent = await order(s, buyer.id, 'DELIVERED', ago(margin - 1));
    const recentClip = await clipFor(recent.orderId, margin + 2);
    const old = await order(s, buyer.id, 'DELIVERED', ago(margin + 1));
    const oldClip = await clipFor(old.orderId, margin + 3);
    const disputed = await order(s, buyer.id, 'DELIVERED', ago(margin + 1));
    await prisma.orderItem.update({ where: { id: disputed.itemId }, data: { status: 'RETURN_REQUESTED' } });
    await prisma.return.create({
      data: { rmaNumber: `RMA-PACK-OLD-${seq}`, orderItemId: disputed.itemId, userId: buyer.id, reason: 'Broken', status: 'REQUESTED' },
    });
    const disputedClip = await clipFor(disputed.orderId, margin + 3);
    const stuck = await order(s, buyer.id, 'SHIPPED');
    const stuckClip = await clipFor(stuck.orderId, margin + 20);
    const cancelled = await order(s, buyer.id, 'CANCELLED');
    const cancelledClip = await clipFor(cancelled.orderId, margin + 5);

    await sweepExpiredPackingVideos(new Date(now));
    const state = async (id: string) => (await prisma.orderPackingVideo.findUniqueOrThrow({ where: { id } })).deletedAt !== null;
    expect(await state(recentClip.id)).toBe(false);
    expect(await state(oldClip.id)).toBe(true);
    expect(await state(disputedClip.id)).toBe(false);
    expect(await state(stuckClip.id)).toBe(false);
    expect(await state(cancelledClip.id)).toBe(true);
    // The bytes behind a removed clip are gone; the kept ones are not.
    const asset = async (ref: string) => prisma.asset.findUniqueOrThrow({ where: { id: ref.slice('asset:'.length) } });
    expect((await asset(oldClip.fileRef)).deletedAt).not.toBeNull();
    expect((await asset(recentClip.fileRef)).deletedAt).toBeNull();

    // Once the return closes, the disputed one goes too.
    await prisma.return.updateMany({ where: { orderItemId: disputed.itemId }, data: { status: 'REFUNDED' } });
    await prisma.orderItem.update({ where: { id: disputed.itemId }, data: { status: 'RETURNED' } });
    await sweepExpiredPackingVideos(new Date(now));
    expect(await state(disputedClip.id)).toBe(true);
  });
});

describe('the listing', () => {
  it('keeps a clip stored on it before, shows it nowhere, and no longer takes one', async () => {
    const s = await seller();
    const detail = await call('GET', `/api/seller/products/${s.product.id}`, s.token);
    expect(detail.text).not.toMatch(/packingVideo/);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: s.product.id } })).packingVideoUrl).toBe('asset:a-listing-clip');
  });
});
