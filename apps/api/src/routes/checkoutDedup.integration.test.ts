import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutResult, PaymentConfirmResult } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { setPaymentProviderForTests } from '../services/payments';
import {
  GatewayError,
  type CreateGatewayOrderInput,
  type GatewayOrder,
  type GatewayOrderState,
  type GatewayPaymentAttempt,
  type GatewayRefund,
  type GatewayRefundInput,
  type PaymentProvider,
} from '../services/payments/PaymentProvider';
import { signAccessToken } from '../utils/jwt';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { settlePaymentSuccess } from '../services/orderService';
import { syncGatewayPayment, targetOf } from '../services/payments/gatewaySync';

/**
 * One cart, one payable order (pre-launch test 2026-10-30, H1, H2 and H5).
 *
 * The same buyer checking out the same cart from two tabs got two orders and
 * could pay both; pressing Pay again after a lost answer or a refresh placed
 * another order and opened another payment; a price raised after the page
 * loaded was charged without a word. Against an in-memory Cashfree.
 */

class FakeCashfree implements PaymentProvider {
  readonly name = 'cashfree' as const;
  readonly mode = 'sandbox' as const;
  orders = new Map<string, { amountPaise: number; currency: string; status: GatewayOrderState['status']; attempts: GatewayPaymentAttempt[] }>();
  created = 0;
  private seq = 0;

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    this.created += 1;
    this.orders.set(input.receipt, { amountPaise: input.amountPaise, currency: 'INR', status: 'ACTIVE', attempts: [] });
    return { providerOrderId: input.receipt, paymentSessionId: `session_${input.receipt}`, expiresAt: input.expiresAt };
  }
  verifySignature(): boolean {
    return false;
  }
  async fetchOrder(id: string): Promise<GatewayOrderState> {
    const o = this.orders.get(id);
    if (!o) throw new GatewayError('order_not_found', 404, 'order_not_found');
    return { status: o.status, amountPaise: o.amountPaise, currency: o.currency, attempts: [...o.attempts].reverse() };
  }
  /** Next terminate: a payment completes and its webhook settles the order while it is being stopped. */
  settleDuringTerminate: string | null = null;
  async terminateOrder(id: string): Promise<boolean> {
    const o = this.orders.get(id)!;
    if (o.status === 'PAID' || o.attempts.some((a) => a.status === 'PENDING')) return false;
    if (this.settleDuringTerminate) {
      const orderId = this.settleDuringTerminate;
      this.settleDuringTerminate = null;
      this.attempt(id, 'SUCCESS');
      await settlePaymentSuccess(orderId, 'cfpay_in_flight');
      return true; // Cashfree accepted the stop request (TERMINATION_REQUESTED)
    }
    o.status = 'TERMINATED';
    return true;
  }
  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    return { providerRefundId: `cf_${input.refundId}`, status: 'PENDING', providerStatus: 'PENDING', message: null };
  }
  async fetchRefund(): Promise<GatewayRefund | null> {
    return null;
  }
  attempt(orderId: string, status: GatewayPaymentAttempt['status']) {
    const o = this.orders.get(orderId)!;
    this.seq += 1;
    o.attempts.push({ providerPaymentId: `cfpay_${this.seq}`, status, amountPaise: o.amountPaise, currency: 'INR', message: status === 'FAILED' ? 'Card declined' : undefined, at: new Date(Date.now() + this.seq) });
    if (status === 'SUCCESS') o.status = 'PAID';
  }
}

const prisma = new PrismaClient();
const cf = new FakeCashfree();
let restore: () => void;
let server: Server;
let base: string;
let variantId: string;
let priceyVariantId: string;
let adminId: string;
let seq = 0;

type Reply<T> = { status: number; json: { data: T; error?: { code: string; message: string; details?: Record<string, unknown> } } };

async function call<T = unknown>(method: string, path: string, token: string | null, body?: unknown): Promise<Reply<T>> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Reply<T>['json'] };
}

/** A buyer with two addresses and one ₹800 book in the cart. */
async function buyerWithCart(variant = variantId, quantity = 1) {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `93710${String(seq).padStart(5, '0')}`, name: `Dedup Buyer ${seq}`, referralCode: `DDP-${seq}` } });
  const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
  const home = await prisma.address.create({
    data: { userId: user.id, name: 'Dedup Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
  });
  const office = await prisma.address.create({
    data: { userId: user.id, name: 'Dedup Buyer', phone: user.phone, line1: '9 Office Lane', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  });
  expect((await call('POST', '/api/cart/items', token, { variantId: variant, quantity })).status).toBe(200);
  return { user, token, home, office };
}

const checkout = (token: string, body: Record<string, unknown>) => call<CheckoutResult>('POST', '/api/orders/checkout', token, { paymentMethod: 'UPI', ...body });
const confirm = (token: string, id: string) => call<PaymentConfirmResult>('POST', '/api/payments/confirm', token, { kind: 'ORDER', id });
const stockOf = async (id = variantId) => (await prisma.productVariant.findUniqueOrThrow({ where: { id } })).stock;
const ordersOf = (userId: string) => prisma.order.findMany({ where: { userId }, include: { payment: true }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  await seedFixture(prisma);
  restore = setPaymentProviderForTests(cf);
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, categoryId: category.id, title: 'Dedup Book', slug: 'checkout-dedup-book', description: 'For the checkout de-duplication tests.', basePricePaise: 80_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  variantId = (await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-DEDUP', pricePaise: 80_000, stock: 500 } })).id;
  const pricey = await prisma.product.create({
    data: { sellerId: seller.id, categoryId: category.id, title: 'Repriced Book', slug: 'checkout-repriced-book', description: 'Its price changes mid-checkout.', basePricePaise: 1_661_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  priceyVariantId = (await prisma.productVariant.create({ data: { productId: pricey.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-REPRICED', pricePaise: 1_661_000, stock: 50 } })).id;
  adminId = (await prisma.user.create({ data: { phone: '9371099999', name: 'Dedup Admin', role: Role.ADMIN, referralCode: 'DDP-A' } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  restore();
  await setSetting('couponsEnabled', DEFAULT_SETTINGS.couponsEnabled);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the same cart checked out from two tabs at once', () => {
  it('is one order with one payment, which both tabs are handed', async () => {
    const b = await buyerWithCart();
    const stock = await stockOf();
    const [a, c] = await Promise.all([checkout(b.token, { addressId: b.home.id }), checkout(b.token, { addressId: b.home.id })]);
    expect([a.status, c.status]).toEqual([200, 200]);
    expect(a.json.data.orderId).toBe(c.json.data.orderId);
    expect(a.json.data.payment.paymentSessionId).toBe(c.json.data.payment.paymentSessionId);
    expect(await ordersOf(b.user.id)).toHaveLength(1);
    expect(await stockOf()).toBe(stock - 1);

    cf.attempt(a.json.data.orderNumber, 'SUCCESS');
    expect((await confirm(b.token, a.json.data.orderId)).json.data.outcome).toBe('PAID');
    const orders = await ordersOf(b.user.id);
    expect(orders.filter((o) => o.payment?.status === 'PAID')).toHaveLength(1);
  });

  it('twelve at once: still one order, one gateway order, no request left hanging', async () => {
    const b = await buyerWithCart();
    const before = cf.created;
    const replies = await Promise.all(Array.from({ length: 12 }, () => checkout(b.token, { addressId: b.home.id })));
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(new Set(replies.map((r) => r.json.data.orderId)).size).toBe(1);
    expect(await ordersOf(b.user.id)).toHaveLength(1);
    expect(cf.created - before).toBe(1);
  });
});

describe('paying again after a lost answer, a failed attempt or a refresh', () => {
  it('a retry with the same checkout key gets the same order and payment back', async () => {
    const b = await buyerWithCart();
    const first = await checkout(b.token, { addressId: b.home.id, checkoutKey: 'tab-key-0001' });
    const retry = await checkout(b.token, { addressId: b.home.id, checkoutKey: 'tab-key-0001' });
    expect(retry.status).toBe(200);
    expect(retry.json.data).toMatchObject({ orderId: first.json.data.orderId, payment: { paymentSessionId: first.json.data.payment.paymentSessionId } });
    expect(await ordersOf(b.user.id)).toHaveLength(1);
  });

  it('after a failed attempt and a refresh (a new key), Pay reopens the same order', async () => {
    const b = await buyerWithCart();
    const first = await checkout(b.token, { addressId: b.home.id, checkoutKey: 'tab-key-0002' });
    cf.attempt(first.json.data.orderNumber, 'FAILED');
    const again = await checkout(b.token, { addressId: b.home.id, checkoutKey: 'tab-key-0003' });
    expect(again.status).toBe(200);
    expect(again.json.data.orderId).toBe(first.json.data.orderId);
    expect(await ordersOf(b.user.id)).toHaveLength(1);
  });

  it('when the first payment went through but its confirmation was lost: no second order, the buyer is sent to the paid one', async () => {
    const b = await buyerWithCart();
    const first = await checkout(b.token, { addressId: b.home.id });
    cf.attempt(first.json.data.orderNumber, 'SUCCESS');
    const again = await checkout(b.token, { addressId: b.home.id });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: 'ALREADY_PAID', details: { orderId: first.json.data.orderId } });
    const orders = await ordersOf(b.user.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.payment!.status).toBe('PAID');
  });

  it('while the bank is still deciding the first payment: no second order or payment', async () => {
    const b = await buyerWithCart();
    const first = await checkout(b.token, { addressId: b.home.id });
    cf.attempt(first.json.data.orderNumber, 'PENDING');
    const again = await checkout(b.token, { addressId: b.home.id });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: 'PAYMENT_PENDING', details: { orderId: first.json.data.orderId } });
    expect(await ordersOf(b.user.id)).toHaveLength(1);
    // And the page is not offered a way to pay again meanwhile.
    expect((await confirm(b.token, first.json.data.orderId)).json.data).toMatchObject({ outcome: 'PENDING', checkout: null, attemptPending: true });
  });
});

describe('a changed checkout for the same items (another address)', () => {
  it('stops and cancels the first order, so only the new one can be paid', async () => {
    const b = await buyerWithCart();
    const stock = await stockOf();
    const first = await checkout(b.token, { addressId: b.home.id });
    const second = await checkout(b.token, { addressId: b.office.id });
    expect(second.status).toBe(200);
    expect(second.json.data.orderId).not.toBe(first.json.data.orderId);
    expect(cf.orders.get(first.json.data.orderNumber)!.status).toBe('TERMINATED');
    const old = await prisma.order.findUniqueOrThrow({ where: { id: first.json.data.orderId }, include: { payment: true } });
    expect(old.status).toBe('CANCELLED');
    expect(old.payment!.status).toBe('FAILED');
    expect(await stockOf()).toBe(stock - 1);
  });

  it('a payment that still lands on the replaced order is refunded in full and the admins are told', async () => {
    const b = await buyerWithCart();
    const first = await checkout(b.token, { addressId: b.home.id });
    await checkout(b.token, { addressId: b.office.id });
    // The bank completes a payment started in the first tab before it was stopped.
    cf.orders.get(first.json.data.orderNumber)!.status = 'ACTIVE';
    cf.attempt(first.json.data.orderNumber, 'SUCCESS');
    const r = await confirm(b.token, first.json.data.orderId);
    expect(r.json.data.outcome).toBe('FAILED');
    const refunds = await prisma.refund.findMany({ where: { orderId: first.json.data.orderId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountPaise).toBe(first.json.data.amountPaise);
    const alerted = () => prisma.notification.count({ where: { userId: adminId, type: 'PAYMENT_LATE_REFUNDED', title: { contains: first.json.data.orderNumber } } });
    for (let i = 0; i < 20 && (await alerted()) === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await alerted()).toBe(1);
  });
});

describe('a price raised after the payment page loaded', () => {
  it('is refused with the new total until the buyer confirms it; nothing is reserved meanwhile', async () => {
    const b = await buyerWithCart(priceyVariantId);
    const shown = 1_661_000;
    await prisma.productVariant.update({ where: { id: priceyVariantId }, data: { pricePaise: 2_491_500 } });
    const stock = await stockOf(priceyVariantId);

    const refused = await checkout(b.token, { addressId: b.home.id, expectedTotalPaise: shown });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: 'PRICE_CHANGED', details: { previousTotalPaise: shown, totalPaise: 2_491_500 } });
    expect(refused.json.error!.message).toContain('₹24,915');
    expect(await ordersOf(b.user.id)).toHaveLength(0);
    expect(await stockOf(priceyVariantId)).toBe(stock);

    const confirmed = await checkout(b.token, { addressId: b.home.id, expectedTotalPaise: 2_491_500 });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.data.amountPaise).toBe(2_491_500);
  });
});

// Review of the H1/H2 fix (2026-10-30): an open order reserves units, credits
// and a coupon use; the same checkout coming again must find them its own.
describe('checking out the same cart again while its first order holds things', () => {
  it('with credits: the retry gets the same order at the same discounted total', async () => {
    const b = await buyerWithCart();
    await prisma.user.update({ where: { id: b.user.id }, data: { creditsBalance: 200 } });
    const first = await checkout(b.token, { addressId: b.home.id, useCredits: true, checkoutKey: 'credit-key-01', expectedTotalPaise: 70_000 });
    expect(first.status).toBe(200);
    expect(first.json.data.amountPaise).toBe(70_000);
    const retry = await checkout(b.token, { addressId: b.home.id, useCredits: true, checkoutKey: 'credit-key-01', expectedTotalPaise: 70_000 });
    expect(retry.status).toBe(200);
    expect(retry.json.data).toMatchObject({ orderId: first.json.data.orderId, amountPaise: 70_000 });
    expect(await ordersOf(b.user.id)).toHaveLength(1);
  });

  it('for the last unit: a refresh and Pay again is not "out of stock" — it is the same order', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'checkout-dedup-book' } });
    const lastOne = await prisma.productVariant.create({
      data: { productId: product.id, optionValues: { cover: 'signed' }, optionsKey: 'signed', label: 'Signed copy', sku: 'SKU-DEDUP-LAST', pricePaise: 80_000, stock: 1 },
    });
    const b = await buyerWithCart(lastOne.id);
    const first = await checkout(b.token, { addressId: b.home.id });
    expect(first.status).toBe(200);
    const cart = await call<{ lines: { variantId: string; stock: number }[] }>('GET', '/api/cart', b.token);
    expect(cart.json.data.lines.find((l) => l.variantId === lastOne.id)!.stock).toBe(1);
    const again = await checkout(b.token, { addressId: b.home.id });
    expect(again.status).toBe(200);
    expect(again.json.data.orderId).toBe(first.json.data.orderId);
  });

  it('with a once-per-account coupon: reloading the cart keeps it, and Pay again keeps the discount', async () => {
    await setSetting('couponsEnabled', true);
    await prisma.coupon.create({ data: { code: 'DEDUPONCE', type: 'FLAT', value: 10_000, perUserLimit: 1 } });
    const b = await buyerWithCart();
    expect((await call('POST', '/api/cart/coupon', b.token, { code: 'DEDUPONCE' })).status).toBe(200);
    const first = await checkout(b.token, { addressId: b.home.id });
    expect(first.status).toBe(200);
    expect(first.json.data.amountPaise).toBe(70_000);
    const cart = await call<{ coupon: { code: string } | null }>('GET', '/api/cart', b.token);
    expect(cart.json.data.coupon?.code).toBe('DEDUPONCE');
    const again = await checkout(b.token, { addressId: b.home.id });
    expect(again.status).toBe(200);
    expect(again.json.data).toMatchObject({ orderId: first.json.data.orderId, amountPaise: 70_000 });
  });
});

describe('a payment that lands while its order is being replaced', () => {
  it('sends the buyer to the paid order instead of placing a second one', async () => {
    const b = await buyerWithCart();
    const first = await checkout(b.token, { addressId: b.home.id });
    cf.settleDuringTerminate = first.json.data.orderId;
    const second = await checkout(b.token, { addressId: b.office.id });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatchObject({ code: 'ALREADY_PAID', details: { orderId: first.json.data.orderId } });
    const orders = await ordersOf(b.user.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.payment!.status).toBe('PAID');
  });
});

describe('a buyer cancelling a Cashfree order not paid yet', () => {
  it('stops the gateway order; a payment that still lands is refunded and never revives the order', async () => {
    const b = await buyerWithCart();
    const stock = await stockOf();
    const first = await checkout(b.token, { addressId: b.home.id });
    expect((await call('POST', `/api/orders/${first.json.data.orderId}/cancel`, b.token)).status).toBe(200);
    expect(cf.orders.get(first.json.data.orderNumber)!.status).toBe('TERMINATED');
    expect(await stockOf()).toBe(stock);
    cf.orders.get(first.json.data.orderNumber)!.status = 'ACTIVE';
    cf.attempt(first.json.data.orderNumber, 'SUCCESS');
    const r = await confirm(b.token, first.json.data.orderId);
    expect(r.json.data.outcome).toBe('FAILED');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: first.json.data.orderId }, include: { refunds: true, items: true } });
    expect(order.status).toBe('CANCELLED');
    expect(order.items.every((i) => i.status === 'CANCELLED')).toBe(true);
    expect(order.refunds).toHaveLength(1);
    expect(await stockOf()).toBe(stock);
  });
});

// Round 3 (review and attack of Batch 1, 2026-10-30).
describe('more of the same checkout coming back', () => {
  it('the cart shows the credits its own unpaid order holds, so the page works out the same total', async () => {
    const b = await buyerWithCart();
    await prisma.user.update({ where: { id: b.user.id }, data: { creditsBalance: 200 } });
    const first = await checkout(b.token, { addressId: b.home.id, useCredits: true });
    expect(first.json.data.amountPaise).toBe(70_000);
    const cart = await call<{ heldCredits: number }>('GET', '/api/cart', b.token);
    expect(cart.json.data.heldCredits).toBe(200);
    const credits = await call<{ balance: number }>('GET', '/api/credits', b.token);
    expect(credits.json.data.balance + cart.json.data.heldCredits).toBe(200);
  });

  it('the last unit, sent to another address instead: the first order is replaced, not "out of stock"', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'checkout-dedup-book' } });
    const lastOne = await prisma.productVariant.create({
      data: { productId: product.id, optionValues: { cover: 'gilded' }, optionsKey: 'gilded', label: 'Gilded', sku: 'SKU-DEDUP-GILD', pricePaise: 80_000, stock: 1 },
    });
    const b = await buyerWithCart(lastOne.id);
    const first = await checkout(b.token, { addressId: b.home.id });
    const moved = await checkout(b.token, { addressId: b.office.id });
    expect(moved.status).toBe(200);
    expect(moved.json.data.orderId).not.toBe(first.json.data.orderId);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.json.data.orderId } })).status).toBe('CANCELLED');
    expect(await stockOf(lastOne.id)).toBe(0);
  });
});

describe('cancelling an unpaid order whose gateway order has already expired', () => {
  it('cancels it, without claiming a payment is with the bank', async () => {
    const b = await buyerWithCart();
    const stock = await stockOf();
    const first = await checkout(b.token, { addressId: b.home.id });
    cf.orders.get(first.json.data.orderNumber)!.status = 'EXPIRED';
    // An expired order cannot be stopped any more: Cashfree refuses the terminate.
    const terminate = cf.terminateOrder.bind(cf);
    cf.terminateOrder = async (id: string) => (cf.orders.get(id)!.status === 'EXPIRED' ? false : terminate(id));
    try {
      const r = await call('POST', `/api/orders/${first.json.data.orderId}/cancel`, b.token);
      expect(r.status).toBe(200);
    } finally {
      cf.terminateOrder = terminate;
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.json.data.orderId } })).status).toBe('CANCELLED');
    expect(await stockOf()).toBe(stock);
  });
});

describe('a second payment on a gateway order already paid (two tabs shared one session)', () => {
  it('is flagged for the admins once when its webhook arrives', async () => {
    const b = await buyerWithCart();
    const first = await checkout(b.token, { addressId: b.home.id });
    cf.attempt(first.json.data.orderNumber, 'SUCCESS');
    expect((await confirm(b.token, first.json.data.orderId)).json.data.outcome).toBe('PAID');
    cf.attempt(first.json.data.orderNumber, 'SUCCESS');
    for (let i = 0; i < 2; i++) await syncGatewayPayment((await targetOf('ORDER', first.json.data.orderId))!, { webhook: true });
    expect(await prisma.auditLog.count({ where: { action: 'Several payments on one order', entityId: first.json.data.orderId } })).toBe(1);
    const alerted = () => prisma.notification.count({ where: { userId: adminId, type: 'PAYMENT_DUPLICATE', title: { contains: first.json.data.orderNumber } } });
    for (let i = 0; i < 20 && (await alerted()) === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await alerted()).toBe(1);
  });
});

describe('changing the cart while its own unpaid order holds things (attack, round 3)', () => {
  it('raising the quantity counts the units its own order holds', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'checkout-dedup-book' } });
    const two = await prisma.productVariant.create({
      data: { productId: product.id, optionValues: { cover: 'two-left' }, optionsKey: 'two-left', label: 'Two left', sku: 'SKU-DEDUP-TWO', pricePaise: 80_000, stock: 2 },
    });
    const b = await buyerWithCart(two.id);
    expect((await checkout(b.token, { addressId: b.home.id })).status).toBe(200);
    const item = await prisma.cartItem.findFirstOrThrow({ where: { cart: { userId: b.user.id }, variantId: two.id } });
    expect((await call('PATCH', `/api/cart/items/${item.id}`, b.token, { quantity: 2 })).status).toBe(200);
  });

  it('re-applying a once-per-account coupon its own unpaid order holds is accepted', async () => {
    await setSetting('couponsEnabled', true);
    await prisma.coupon.create({ data: { code: 'DEDUPAGAIN', type: 'FLAT', value: 10_000, perUserLimit: 1 } });
    const b = await buyerWithCart();
    expect((await call('POST', '/api/cart/coupon', b.token, { code: 'DEDUPAGAIN' })).status).toBe(200);
    const first = await checkout(b.token, { addressId: b.home.id });
    expect(first.json.data.amountPaise).toBe(70_000);
    expect((await call('DELETE', '/api/cart/coupon', b.token)).status).toBe(200);
    expect((await call('POST', '/api/cart/coupon', b.token, { code: 'DEDUPAGAIN' })).status).toBe(200);
    const again = await checkout(b.token, { addressId: b.home.id });
    expect(again.json.data).toMatchObject({ orderId: first.json.data.orderId, amountPaise: 70_000 });
  });
});

describe('a coupon used by many buyers at the same moment (attack, round 4)', () => {
  it('with no limit: every checkout gets it', async () => {
    await setSetting('couponsEnabled', true);
    await prisma.coupon.create({ data: { code: 'EVERYONE10', type: 'FLAT', value: 5_000 } });
    // Each buyer a different item: nothing else makes their checkouts wait for one another.
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'checkout-dedup-book' } });
    const buyers = [];
    for (let i = 0; i < 10; i++) {
      const own = await prisma.productVariant.create({
        data: { productId: product.id, optionValues: { copy: `everyone-${i}` }, optionsKey: `everyone-${i}`, label: `Copy ${i}`, sku: `SKU-EVERYONE-${i}`, pricePaise: 80_000, stock: 5 },
      });
      buyers.push(await buyerWithCart(own.id));
    }
    for (const b of buyers) expect((await call('POST', '/api/cart/coupon', b.token, { code: 'EVERYONE10' })).status).toBe(200);
    const replies = await Promise.all(buyers.map((b) => checkout(b.token, { addressId: b.home.id })));
    expect(replies.map((r) => r.status)).toEqual(replies.map(() => 200));
    expect(replies.every((r) => r.json.data.amountPaise === 75_000)).toBe(true);
  });

  it('with 3 uses left: exactly 3 checkouts get it', async () => {
    await setSetting('couponsEnabled', true);
    await prisma.coupon.create({ data: { code: 'ONLYTHREE', type: 'FLAT', value: 5_000, usageLimit: 3 } });
    const buyers = await Promise.all(Array.from({ length: 8 }, () => buyerWithCart()));
    for (const b of buyers) expect((await call('POST', '/api/cart/coupon', b.token, { code: 'ONLYTHREE' })).status).toBe(200);
    await Promise.all(buyers.map((b) => checkout(b.token, { addressId: b.home.id })));
    expect(await prisma.order.count({ where: { couponCode: 'ONLYTHREE', status: { not: 'CANCELLED' } } })).toBe(3);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: 'ONLYTHREE' } })).usedCount).toBe(3);
  });
});
