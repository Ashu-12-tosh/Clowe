import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { paymentProvider } from '../services/payments';
import { signAccessToken } from '../utils/jwt';

/**
 * Cancelling a paid order gives the money back through the payment gateway —
 * the same path a return's refund takes — and records the refund. It used to
 * mark the payment REFUNDED and do nothing else, and the payment's time was
 * lost with it.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let variantId: string;
let adminToken: string;
let seq = 0;

interface Body {
  data: { orderId: string; status: string; refund: unknown; payment: unknown };
  error?: { code: string };
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

/** A shopper with one ₹800 item ordered and, unless COD, paid. */
async function orderAs(method: 'UPI' | 'COD') {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91960${String(seq).padStart(5, '0')}`, name: `Cancel Buyer ${seq}`, referralCode: `CXL-${seq}` } });
  const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
  const address = await prisma.address.create({
    data: { userId: user.id, name: 'Cancel Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
  });
  expect((await call('POST', '/api/cart/items', token, { variantId, quantity: 1 })).status).toBe(200);
  const co = await call('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: method });
  expect(co.status).toBe(200);
  const orderId = co.json.data.orderId;
  if (method !== 'COD') {
    expect((await call('POST', '/api/payments/mock-pay', token, { orderId, outcome: 'success' })).status).toBe(200);
  }
  return { token, orderId, userId: user.id };
}

beforeAll(async () => {
  await seedFixture(prisma);
  // These carts are under ₹1,000; the COD floor itself is codCap's test.
  await setSetting('codMinOrderPaise', 0);
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, categoryId: category.id, title: 'Cancel Refund Book', slug: 'cancel-refund-book', description: 'For the cancellation tests.', basePricePaise: 80_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  variantId = (
    await prisma.productVariant.create({
      data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-CXL', pricePaise: 80_000, stock: 100 },
    })
  ).id;
  const admin = await prisma.user.create({ data: { phone: '9196100000', name: 'Cancel Admin', role: Role.ADMIN, referralCode: 'CXL-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await setSetting('codMinOrderPaise', DEFAULT_SETTINGS.codMinOrderPaise);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a customer cancelling a paid order', () => {
  it('is refunded through the gateway, with the refund recorded and the payment time kept', async () => {
    const refundSpy = vi.spyOn(paymentProvider, 'refund');
    const { token, orderId, userId } = await orderAs('UPI');
    const paid = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).not.toBeNull();

    const res = await call('POST', `/api/orders/${orderId}/cancel`, token);
    expect(res.status).toBe(200);
    expect(res.json.data.refund).toMatchObject({ status: 'PROCESSED', amountPaise: paid.amountPaise });

    // The gateway was asked for exactly what was paid, against that payment.
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledWith(paid.providerPaymentId, paid.amountPaise);

    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
    expect(refund).toMatchObject({ status: 'PROCESSED', amountPaise: paid.amountPaise, returnId: null, reason: 'Order cancelled by customer' });
    expect(refund.providerRefundId).toBeTruthy();

    const after = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(after.status).toBe('REFUNDED');
    expect(after.paidAt?.toISOString()).toBe(paid.paidAt!.toISOString());

    const detail = await call('GET', `/api/orders/${orderId}`, token);
    expect(detail.json.data.status).toBe('CANCELLED');
    expect(detail.json.data.payment).toMatchObject({ status: 'REFUNDED', paidAt: paid.paidAt!.toISOString() });

    expect(await prisma.notification.count({ where: { userId, type: 'REFUND_PROCESSED' } })).toBe(1);
  });

  it('records a failed refund for an admin to retry, and leaves the payment PAID', async () => {
    const { token, orderId } = await orderAs('UPI');
    vi.spyOn(paymentProvider, 'refund').mockRejectedValueOnce(new Error('gateway down'));

    const res = await call('POST', `/api/orders/${orderId}/cancel`, token);
    expect(res.status).toBe(200);
    expect(res.json.data.refund).toMatchObject({ status: 'FAILED' });

    expect(await prisma.refund.findFirstOrThrow({ where: { orderId } })).toMatchObject({ status: 'FAILED', failureReason: 'gateway down' });
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId } })).status).toBe('PAID');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
  });

  it('owes nothing on a COD order that has not been delivered', async () => {
    const refundSpy = vi.spyOn(paymentProvider, 'refund');
    const { token, orderId } = await orderAs('COD');
    const res = await call('POST', `/api/orders/${orderId}/cancel`, token);
    expect(res.status).toBe(200);
    expect(res.json.data.refund).toBeNull();
    expect(refundSpy).not.toHaveBeenCalled();
    expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
  });
});

describe('an admin cancelling a paid order', () => {
  it('refunds it the same way, recording who issued it', async () => {
    const { orderId } = await orderAs('UPI');
    const paid = await prisma.payment.findUniqueOrThrow({ where: { orderId } });

    const res = await call('POST', `/api/admin/orders/${orderId}/cancel`, adminToken, { reason: 'Out of stock at the seller' });
    expect(res.status).toBe(200);
    expect(res.json.data.refund).toMatchObject({ status: 'PROCESSED', amountPaise: paid.amountPaise });

    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
    expect(refund.reason).toBe('Cancelled by admin: Out of stock at the seller');
    expect(refund.issuedByAdminId).toBeTruthy();
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId } })).status).toBe('REFUNDED');
  });
});
