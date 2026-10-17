import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTERCEPT_SUBJECT, type OrderDetailView } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture, TEST_SELLER_ADDRESS } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * The Cancellation Policy, as the code keeps it:
 *  - 2.1 an item marked non-cancellable says so before ordering, and cannot
 *    be cancelled by the buyer once the order is confirmed;
 *  - 3.1/3.2 a seller or an admin may cancel part of an order — the buyer is
 *    told which item and why, and refunded what they paid for it;
 *  - 1.2 after dispatch the buyer cannot cancel, but can ask support to stop
 *    the parcel: a ticket forwarded to the seller and the desk.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
let sellerToken: string;
let sellerId: string;
let adminToken: string;
const v: Record<'plain' | 'other' | 'custom', string> = {} as never;

interface Body<T = Record<string, unknown>> {
  data: T;
  error?: { code: string; message: string };
}
async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Body<T> };
}

async function buyer() {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91932${String(seq).padStart(5, '0')}`, name: `Cancel Buyer ${seq}`, referralCode: `OCX-${seq}` } });
  const address = await prisma.address.create({
    data: { userId: user.id, name: 'Cancel Buyer', phone: user.phone, line1: '3 Lake Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
  });
  return { userId: user.id, token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }), addressId: address.id };
}

/** An order for these variants; paid (confirmed) unless `unpaid`. */
async function order(variants: string[], opts: { unpaid?: boolean } = {}) {
  const b = await buyer();
  for (const variantId of variants) expect((await call('POST', '/api/cart/items', b.token, { variantId, quantity: 1 })).status).toBe(200);
  const co = await call<{ orderId: string }>('POST', '/api/orders/checkout', b.token, { addressId: b.addressId, paymentMethod: 'UPI' });
  expect(co.status, JSON.stringify(co.json)).toBe(200);
  const orderId = co.json.data.orderId;
  if (!opts.unpaid) expect((await call('POST', '/api/payments/mock-pay', b.token, { orderId, outcome: 'success' })).status).toBe(200);
  const items = await prisma.orderItem.findMany({ where: { orderId } });
  const line = (variantId: string) => items.find((i) => i.variantId === variantId)!;
  return { ...b, orderId, line };
}

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const user = await prisma.user.create({ data: { phone: '9193100001', name: 'Cancel Seller', role: Role.SELLER, referralCode: 'OCX-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: { ...TEST_SELLER_ADDRESS, userId: user.id, shopName: 'Cancel Shop', slug: 'cancel-shop-ocx', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5' },
    })
  ).id;
  sellerToken = signAccessToken({ sub: user.id, role: 'SELLER' });
  for (const [key, nonCancellable] of [['plain', false], ['other', false], ['custom', true]] as const) {
    const product = await prisma.product.create({
      data: {
        sellerId, categoryId: category.id, title: `Cancel ${key}`, slug: `ocx-${key}`, description: 'For the cancellation tests.',
        basePricePaise: 60_000, status: ProductStatus.APPROVED, approvedAt: new Date(), nonCancellable,
      },
    });
    v[key] = (await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: `SKU-OCX-${key}`, pricePaise: 60_000, stock: 100 } })).id;
  }
  const admin = await prisma.user.create({ data: { phone: '9193100002', name: 'Cancel Admin', role: Role.ADMIN, referralCode: 'OCX-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('non-cancellable items (2.1)', () => {
  it('are marked on the product page and in the cart, before the order', async () => {
    const pdp = await call<{ nonCancellable: boolean }>('GET', '/api/products/ocx-custom', null);
    expect(pdp.json.data.nonCancellable).toBe(true);
    expect((await call<{ nonCancellable: boolean }>('GET', '/api/products/ocx-plain', null)).json.data.nonCancellable).toBe(false);
    const b = await buyer();
    await call('POST', '/api/cart/items', b.token, { variantId: v.custom, quantity: 1 });
    const cart = await call<{ lines: { nonCancellable: boolean }[] }>('GET', '/api/cart', b.token);
    expect(cart.json.data.lines[0]!.nonCancellable).toBe(true);
  });

  it('cannot be cancelled once confirmed, and the line keeps the mark', async () => {
    const o = await order([v.custom]);
    expect(o.line(v.custom).nonCancellable).toBe(true);
    const detail = await call<OrderDetailView>('GET', `/api/orders/${o.orderId}`, o.token);
    expect(detail.json.data.canCancel).toBe(false);
    expect(detail.json.data.items[0]!.nonCancellable).toBe(true);
    const res = await call('POST', `/api/orders/${o.orderId}/cancel`, o.token);
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('NON_CANCELLABLE');
  });

  it('can be cancelled while the order is not yet confirmed (unpaid)', async () => {
    const o = await order([v.custom], { unpaid: true });
    expect((await call('POST', `/api/orders/${o.orderId}/cancel`, o.token)).status).toBe(200);
  });

  it('stay when the buyer cancels the rest of the order, refunded for the rest only', async () => {
    const o = await order([v.plain, v.custom]);
    const res = await call<{ kept: number; refund: { amountPaise: number } }>('POST', `/api/orders/${o.orderId}/cancel`, o.token);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data).toMatchObject({ kept: 1, refund: { amountPaise: 60_000 } });
    const lines = await prisma.orderItem.findMany({ where: { orderId: o.orderId } });
    expect(Object.fromEntries(lines.map((l) => [l.variantId, l.status]))).toEqual({ [v.plain]: 'CANCELLED', [v.custom]: 'CONFIRMED' });
  });
});

describe('a seller cancelling part of an order (3.1, 3.2)', () => {
  it('cancels only the item picked, tells the buyer why, and refunds that item', async () => {
    const o = await order([v.plain, v.other]);
    const res = await call<{ cancelledLines: number; refund: { amountPaise: number } }>('POST', `/api/seller/orders/${o.orderId}/cancel`, sellerToken, {
      reason: 'Out of stock or discontinued',
      itemIds: [o.line(v.other).id],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data).toMatchObject({ cancelledLines: 1, refund: { amountPaise: 60_000 } });
    const other = await prisma.orderItem.findUniqueOrThrow({ where: { id: o.line(v.other).id } });
    expect(other).toMatchObject({ status: 'CANCELLED', cancelReason: 'Out of stock or discontinued' });
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.line(v.plain).id } })).status).toBe('CONFIRMED');
    const told = await prisma.notification.findFirstOrThrow({ where: { userId: o.userId, type: 'ORDER_CANCELLED' } });
    expect(told.title).toContain('Part of order');
    expect(told.body).toContain('Out of stock or discontinued');
    const detail = await call<OrderDetailView>('GET', `/api/orders/${o.orderId}`, o.token);
    expect(detail.json.data.items.find((i) => i.id === o.line(v.other).id)?.cancelReason).toBe('Out of stock or discontinued');
  });

  it('refuses an item that is not on the order', async () => {
    const o = await order([v.plain]);
    const res = await call('POST', `/api/seller/orders/${o.orderId}/cancel`, sellerToken, { reason: 'Out of stock or discontinued', itemIds: ['nope'] });
    expect(res.status).toBe(404);
  });
});

describe('an admin cancelling one item (3.1)', () => {
  it('cancels it with the reason the buyer is told, and refunds it; delivered items are refused', async () => {
    const o = await order([v.plain, v.other]);
    const res = await call<{ cancelledLines: number; refund: { amountPaise: number } }>('POST', `/api/admin/orders/${o.orderId}/items/cancel`, adminToken, {
      reason: 'Price, description or image shown in error',
      itemIds: [o.line(v.plain).id],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data).toMatchObject({ cancelledLines: 1, refund: { amountPaise: 60_000 } });
    const told = await prisma.notification.findFirstOrThrow({ where: { userId: o.userId, type: 'ORDER_CANCELLED' } });
    expect(told.title).toContain('cancelled by Clowe');
    expect(told.body).toContain('shown in error');

    await prisma.orderItem.update({ where: { id: o.line(v.other).id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    const late = await call('POST', `/api/admin/orders/${o.orderId}/items/cancel`, adminToken, { reason: 'Too late', itemIds: [o.line(v.other).id] });
    expect(late.json.error?.code).toBe('ALREADY_DELIVERED');
  });
});

describe('after dispatch: asking to stop the parcel (1.2)', () => {
  it('is the only way once shipped: cancel is refused, the request becomes a ticket for the seller and the desk', async () => {
    const o = await order([v.plain]);
    await prisma.orderItem.updateMany({ where: { orderId: o.orderId }, data: { status: 'SHIPPED', shippedAt: new Date() } });
    const cancel = await call('POST', `/api/orders/${o.orderId}/cancel`, o.token);
    expect(cancel.json.error?.code).toBe('ALREADY_SHIPPED');
    expect((await call<OrderDetailView>('GET', `/api/orders/${o.orderId}`, o.token)).json.data.canRequestIntercept).toBe(true);

    const res = await call<{ complaintId: string }>('POST', `/api/orders/${o.orderId}/intercept`, o.token, { note: 'Ordered twice by mistake' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const ticket = await prisma.complaint.findUniqueOrThrow({ where: { complaintId: res.json.data.complaintId } });
    expect(ticket).toMatchObject({ subject: INTERCEPT_SUBJECT, category: 'DELIVERY', priority: 'HIGH', orderId: o.orderId });
    expect(ticket.description).toContain('Ordered twice by mistake');
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } });
    expect(await prisma.notification.count({ where: { userId: seller.userId, type: 'INTERCEPT_REQUEST' } })).toBeGreaterThan(0);

    const detail = (await call<OrderDetailView>('GET', `/api/orders/${o.orderId}`, o.token)).json.data;
    expect(detail.canRequestIntercept).toBe(false);
    expect(detail.interceptRequest?.complaintId).toBe(res.json.data.complaintId);
    expect((await call('POST', `/api/orders/${o.orderId}/intercept`, o.token, {})).json.error?.code).toBe('ALREADY_REQUESTED');
  });

  it('is not offered before dispatch', async () => {
    const o = await order([v.plain]);
    expect((await call('POST', `/api/orders/${o.orderId}/intercept`, o.token, {})).json.error?.code).toBe('NOT_IN_TRANSIT');
  });
});
