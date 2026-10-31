import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { paymentProvider } from '../services/payments';
import { signAccessToken } from '../utils/jwt';
import { sweepUnpaidGatewayPayments } from '../services/payments/gatewaySync';

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
    expect(refundSpy).toHaveBeenCalledWith(
      expect.objectContaining({ providerPaymentId: paid.providerPaymentId, amountPaise: paid.amountPaise, refundId: expect.any(String) }),
    );

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

describe('an admin cancelling with a reason from the list', () => {
  it('tells the customer the fixed words, never "fraud"; "Other" needs its own words', async () => {
    const { orderId } = await orderAs('UPI');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect((await call('POST', `/api/admin/orders/${orderId}/cancel`, adminToken, { reasonCode: 'OTHER', otherText: 'no' })).status).toBe(400);
    expect((await call('POST', `/api/admin/orders/${orderId}/cancel`, adminToken, {})).status).toBe(400);
    const res = await call('POST', `/api/admin/orders/${orderId}/cancel`, adminToken, { reasonCode: 'SUSPECTED_FRAUD' });
    expect(res.status).toBe(200);
    const told = await prisma.notification.findFirstOrThrow({ where: { userId: order.userId, type: 'ORDER_CANCELLED' }, orderBy: { createdAt: 'desc' } });
    expect(told.body).toBe('We could not verify this order, so we have cancelled it.');
    expect(told.body).not.toMatch(/fraud/i);
  });
});

// Pre-launch audit (2026-10-21): a refund must leave once, however many
// requests for it arrive together — a double-tapped Cancel, the shopper and an
// admin cancelling at the same moment, an admin's Retry clicked three times.
describe('refunds when requests arrive together', () => {
  it('cancelled three times by the shopper and once by an admin, at once: one refund, asked of the gateway once', async () => {
    const refundSpy = vi.spyOn(paymentProvider, 'refund');
    const { token, orderId } = await orderAs('UPI');
    const paid = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    await Promise.all([
      call('POST', `/api/orders/${orderId}/cancel`, token),
      call('POST', `/api/orders/${orderId}/cancel`, token),
      call('POST', `/api/orders/${orderId}/cancel`, token),
      call('POST', `/api/admin/orders/${orderId}/cancel`, adminToken, { reason: 'Out of stock at the seller' }),
    ]);
    const refunds = await prisma.refund.findMany({ where: { orderId, status: { not: 'FAILED' } } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountPaise).toBe(paid.amountPaise);
    expect(refundSpy).toHaveBeenCalledTimes(1);
  });

  it('a failed refund retried three times at once: sent once', async () => {
    const { token, orderId } = await orderAs('UPI');
    vi.spyOn(paymentProvider, 'refund').mockRejectedValueOnce(new Error('gateway down'));
    await call('POST', `/api/orders/${orderId}/cancel`, token);
    const failed = await prisma.refund.findFirstOrThrow({ where: { orderId } });
    expect(failed.status).toBe('FAILED');
    vi.restoreAllMocks();
    const refundSpy = vi.spyOn(paymentProvider, 'refund');
    await Promise.all(Array.from({ length: 3 }, () => call('POST', `/api/admin/payments/refunds/${failed.id}/retry`, adminToken)));
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('PROCESSED');
    expect(await prisma.refund.count({ where: { orderId } })).toBe(1);
  });
});

// Pre-launch test (2026-10-30, C1): five admin Cancel clicks at once — two
// admins, two tabs, a retry after a lost response — refunded the order three
// times, put the unit back on the shelf five times, took the earned credits
// back twice and told the buyer five times. One cancel must do each once.
describe('an admin cancelling the same paid order five times at once', () => {
  it('cancels once: one refund, one unit back, one credit reversal, one message', async () => {
    const refundSpy = vi.spyOn(paymentProvider, 'refund');
    const { orderId, userId } = await orderAs('UPI');
    const paid = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    const stockBefore = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    const earned = await prisma.creditLedger.aggregate({ where: { orderId, reason: 'EARN_PURCHASE' }, _sum: { delta: true } });
    const balanceBefore = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditsBalance;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => call('POST', `/api/admin/orders/${orderId}/cancel`, adminToken, { reason: 'Seller out of stock' })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.every((r) => r.status === 200 || r.status === 400 || r.status === 409)).toBe(true);

    const refunds = await prisma.refund.findMany({ where: { orderId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountPaise).toBe(paid.amountPaise);
    expect(refundSpy).toHaveBeenCalledTimes(1);

    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock).toBe(stockBefore + 1);

    const reversals = await prisma.creditLedger.findMany({ where: { orderId, reason: 'REVERSE_PURCHASE' } });
    expect(reversals.reduce((s, e) => s + e.delta, 0)).toBe(-(earned._sum.delta ?? 0));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditsBalance).toBe(balanceBefore - (earned._sum.delta ?? 0));

    expect(await prisma.notification.count({ where: { userId, type: 'ORDER_CANCELLED' } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
  });
});

// Review of the C1 fix (2026-10-30): the cancel path admin cancel now shares.
describe('a line cancel and a whole-order cancel at the same moment', () => {
  it('never leaves a line cancelled with its stock not returned', async () => {
    seq += 1;
    const user = await prisma.user.create({ data: { phone: `91961${String(seq).padStart(5, '0')}`, name: `Two Line Buyer ${seq}`, referralCode: `CXL2-${seq}` } });
    const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
    const address = await prisma.address.create({
      data: { userId: user.id, name: 'Two Line Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
    });
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'cancel-refund-book' } });
    const second = await prisma.productVariant.create({
      data: { productId: product.id, optionValues: { edition: `hardback-${seq}` }, optionsKey: `hardback-${seq}`, label: 'Hardback', sku: `SKU-CXL-HB-${seq}`, pricePaise: 80_000, stock: 100 },
    });
    expect((await call('POST', '/api/cart/items', token, { variantId, quantity: 1 })).status).toBe(200);
    expect((await call('POST', '/api/cart/items', token, { variantId: second.id, quantity: 1 })).status).toBe(200);
    const co = await call('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: 'UPI' });
    const orderId = co.json.data.orderId;
    expect((await call('POST', '/api/payments/mock-pay', token, { orderId, outcome: 'success' })).status).toBe(200);
    const before = { a: (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock, b: 100 - 1 };
    const items = await prisma.orderItem.findMany({ where: { orderId } });
    const lineA = items.find((i) => i.variantId === variantId)!;

    await Promise.all([
      call('POST', `/api/admin/orders/${orderId}/items/cancel`, adminToken, { itemIds: [lineA.id], reason: 'Damaged in the warehouse' }),
      call('POST', `/api/admin/orders/${orderId}/cancel`, adminToken, { reason: 'Seller out of stock' }),
    ]);

    const after = await prisma.orderItem.findMany({ where: { orderId } });
    const stockA = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    const stockB = (await prisma.productVariant.findUniqueOrThrow({ where: { id: second.id } })).stock;
    const lineAfter = (v: string) => after.find((i) => i.variantId === v)!;
    expect(stockA).toBe(before.a + (lineAfter(variantId).status === 'CANCELLED' ? 1 : 0));
    expect(stockB).toBe(before.b + (lineAfter(second.id).status === 'CANCELLED' ? 1 : 0));
    const refunded = (await prisma.refund.findMany({ where: { orderId } })).reduce((s, r) => s + r.amountPaise, 0);
    const paid = (await prisma.payment.findUniqueOrThrow({ where: { orderId } })).amountPaise;
    expect(refunded).toBeLessThanOrEqual(paid);
    if (after.every((i) => i.status === 'CANCELLED')) expect(refunded).toBe(paid);
  });
});

describe('a buyer cancelling an order not paid yet', () => {
  it('gives stock and credits back once: the payment sweeper later does not give them back again', async () => {
    seq += 1;
    const user = await prisma.user.create({ data: { phone: `91962${String(seq).padStart(5, '0')}`, name: `Unpaid Buyer ${seq}`, referralCode: `CXL3-${seq}`, creditsBalance: 100 } });
    const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
    const address = await prisma.address.create({
      data: { userId: user.id, name: 'Unpaid Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
    });
    const stockBefore = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    expect((await call('POST', '/api/cart/items', token, { variantId, quantity: 1 })).status).toBe(200);
    const co = await call('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: 'UPI', useCredits: true });
    expect(co.status).toBe(200);
    const orderId = co.json.data.orderId;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).creditsBalance).toBe(0);

    expect((await call('POST', `/api/orders/${orderId}/cancel`, token)).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).creditsBalance).toBe(100);
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock).toBe(stockBefore);

    // Its time runs out and the sweeper comes by.
    await prisma.payment.update({ where: { orderId }, data: { createdAt: new Date(Date.now() - 3 * 3_600_000) } });
    await sweepUnpaidGatewayPayments();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).creditsBalance).toBe(100);
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock).toBe(stockBefore);

    // A payment for it is not taken, and never revives it.
    expect((await call('POST', '/api/payments/mock-pay', token, { orderId, outcome: 'success' })).status).toBe(400);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId } })).status).toBe('FAILED');
  });
});

// Attack on Batch 1 (2026-10-30, agent C): two partial cancels at once each
// thought the other line was still live, so neither saw the order emptied and
// the buyer's redeemed credits never came back; a cancel and a payment at once
// deadlocked or left the order half cancelled, half confirmed.
describe('two line cancels of one order at the same moment', () => {
  it('together empty the order: credits back once, the whole payment refunded', async () => {
    seq += 1;
    const user = await prisma.user.create({ data: { phone: `91963${String(seq).padStart(5, '0')}`, name: `Split Buyer ${seq}`, referralCode: `CXL4-${seq}`, creditsBalance: 600 } });
    const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
    const address = await prisma.address.create({
      data: { userId: user.id, name: 'Split Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
    });
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'cancel-refund-book' } });
    const second = await prisma.productVariant.create({
      data: { productId: product.id, optionValues: { edition: `split-${seq}` }, optionsKey: `split-${seq}`, label: 'Split', sku: `SKU-CXL-SP-${seq}`, pricePaise: 80_000, stock: 100 },
    });
    await call('POST', '/api/cart/items', token, { variantId, quantity: 1 });
    await call('POST', '/api/cart/items', token, { variantId: second.id, quantity: 1 });
    const co = await call('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: 'UPI', useCredits: true });
    const orderId = co.json.data.orderId;
    await call('POST', '/api/payments/mock-pay', token, { orderId, outcome: 'success' });
    const used = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).creditsUsed;
    expect(used).toBeGreaterThan(0);
    const [l1, l2] = await prisma.orderItem.findMany({ where: { orderId } });

    const replies = await Promise.all([
      call('POST', `/api/admin/orders/${orderId}/items/cancel`, adminToken, { itemIds: [l1!.id], reason: 'Damaged' }),
      call('POST', `/api/admin/orders/${orderId}/items/cancel`, adminToken, { itemIds: [l2!.id], reason: 'Damaged' }),
    ]);
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
    const back = await prisma.creditLedger.findMany({ where: { orderId, reason: 'REFUND_CREDITS' } });
    expect(back.map((e) => e.delta)).toEqual([used]);
    const paid = (await prisma.payment.findUniqueOrThrow({ where: { orderId } })).amountPaise;
    const refunded = (await prisma.refund.findMany({ where: { orderId } })).reduce((s, r) => s + r.amountPaise, 0);
    expect(refunded).toBe(paid);
  });
});

describe('a cancel and a payment arriving at the same moment', () => {
  it('ends either cancelled and unpaid or paid and confirmed — never half of each, never a 500', async () => {
    for (let round = 0; round < 12; round++) {
      seq += 1;
      const user = await prisma.user.create({ data: { phone: `91964${String(seq).padStart(5, '0')}`, name: `Race Buyer ${seq}`, referralCode: `CXL5-${seq}` } });
      const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
      const address = await prisma.address.create({
        data: { userId: user.id, name: 'Race Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
      });
      await call('POST', '/api/cart/items', token, { variantId, quantity: 1 });
      const stockBefore = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
      const co = await call('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: 'UPI' });
      const orderId = co.json.data.orderId;
      const cancelFirst = round % 2 === 0;
      const replies = await Promise.all(
        cancelFirst
          ? [call('POST', `/api/admin/orders/${orderId}/cancel`, adminToken, { reason: 'Race' }), call('POST', '/api/payments/mock-pay', token, { orderId, outcome: 'success' })]
          : [call('POST', '/api/payments/mock-pay', token, { orderId, outcome: 'success' }), call('POST', `/api/orders/${orderId}/cancel`, token)],
      );
      expect(replies.every((r) => r.status < 500)).toBe(true);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, payment: true, refunds: true } });
      const stock = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
      if (order.status === 'CANCELLED') {
        expect(order.items.every((i) => i.status === 'CANCELLED')).toBe(true);
        expect(stock).toBe(stockBefore);
        // Paid then cancelled: refunded in full; never paid: nothing to refund.
        const refunded = order.refunds.reduce((s, r) => s + r.amountPaise, 0);
        expect(refunded).toBe(order.payment!.status === 'FAILED' ? 0 : order.payment!.amountPaise);
      } else {
        expect(order.status).toBe('CONFIRMED');
        expect(order.payment!.status).toBe('PAID');
        expect(order.items.every((i) => i.status === 'CONFIRMED')).toBe(true);
        expect(stock).toBe(stockBefore - 1);
      }
    }
  });
});

// Attack on Batch 1 (2026-10-30, agent A on staging): multi-item orders taking
// and giving back stock at the same time locked the variants in different
// orders and deadlocked — 76 checkouts, cancels and payments answered 500.
describe('multi-item orders placed and cancelled at the same moment', () => {
  it('never deadlock', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'cancel-refund-book' } });
    const variants = [];
    for (const v of ['dl-a', 'dl-b', 'dl-c', 'dl-d']) {
      variants.push(
        await prisma.productVariant.create({
          data: { productId: product.id, optionValues: { set: v }, optionsKey: v, label: v, sku: `SKU-CXL-${v}`, pricePaise: 20_000, stock: 1000 },
        }),
      );
    }
    const buyers = [];
    for (let n = 0; n < 6; n++) {
      seq += 1;
      const user = await prisma.user.create({ data: { phone: `91965${String(seq).padStart(5, '0')}`, name: `Lock Buyer ${seq}`, referralCode: `CXL6-${seq}` } });
      const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
      const address = await prisma.address.create({
        data: { userId: user.id, name: 'Lock Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
      });
      buyers.push({ token, addressId: address.id, order: n % 2 === 0 ? variants : [...variants].reverse() });
    }
    const statuses: number[] = [];
    for (let round = 0; round < 4; round++) {
      for (const b of buyers) for (const v of b.order) await call('POST', '/api/cart/items', b.token, { variantId: v.id, quantity: 1 });
      const placed = await Promise.all(buyers.map((b) => call('POST', '/api/orders/checkout', b.token, { addressId: b.addressId, paymentMethod: 'UPI' })));
      statuses.push(...placed.map((r) => r.status));
      const cancelled = await Promise.all(
        buyers.map((b, i) => (placed[i]!.status === 200 ? call('POST', `/api/orders/${placed[i]!.json.data.orderId}/cancel`, b.token) : Promise.resolve({ status: 200 }))),
      );
      statuses.push(...cancelled.map((r) => r.status));
    }
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });
});
