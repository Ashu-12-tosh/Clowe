import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutResult, CreditPurchaseResult, PaymentConfirmResult, PromotionCreditPurchaseResult } from '@clowe/shared';
import { createApp } from '../app';
import { env } from '../env';
import { seedFixture } from '../test/fixture';
import { setSetting, DEFAULT_SETTINGS } from '../services/settingsService';
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
import { sweepUnpaidGatewayPayments } from '../services/payments/gatewaySync';
import { pollProcessingRefunds, retryRefund } from '../services/refundService';
import { signAccessToken } from '../utils/jwt';

/**
 * Cashfree payments end to end, against an in-memory Cashfree that behaves
 * like the real one: an order stays payable after a failed attempt, a refund
 * is accepted first and settled later, and the browser is never believed —
 * the server asks the gateway, from the page, from a webhook and from the
 * sweeper, and acts on the answer exactly once.
 */

class FakeCashfree implements PaymentProvider {
  readonly name = 'cashfree' as const;
  readonly mode = 'sandbox' as const;
  orders = new Map<string, { amountPaise: number; currency: string; status: GatewayOrderState['status']; attempts: GatewayPaymentAttempt[]; splits?: CreateGatewayOrderInput['splits'] }>();
  refunds = new Map<string, GatewayRefund>();
  refundCalls: GatewayRefundInput[] = [];
  /** What the next refund call answers (or throws). */
  nextRefund: Array<GatewayRefund['status'] | 'THROW_UNCERTAIN'> = [];
  private seq = 0;

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    this.orders.set(input.receipt, { amountPaise: input.amountPaise, currency: 'INR', status: 'ACTIVE', attempts: [], splits: input.splits });
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
  async terminateOrder(id: string): Promise<boolean> {
    const o = this.orders.get(id)!;
    if (o.attempts.some((a) => a.status === 'PENDING')) return false;
    o.status = 'TERMINATED';
    return true;
  }
  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    this.refundCalls.push(input);
    const next = this.nextRefund.shift() ?? 'PENDING';
    if (next === 'THROW_UNCERTAIN') throw new GatewayError('timed out', 0, 'network');
    const r: GatewayRefund = { providerRefundId: `cf_${input.refundId}`, status: next, providerStatus: next === 'FAILED' ? 'REJECTED' : next, message: next === 'FAILED' ? 'Refund rejected by bank' : null };
    this.refunds.set(input.refundId, r);
    return r;
  }
  async fetchRefund(_orderId: string, refundId: string): Promise<GatewayRefund | null> {
    return this.refunds.get(refundId) ?? null;
  }

  /** The buyer tries to pay. */
  attempt(orderId: string, status: GatewayPaymentAttempt['status'], amountPaise?: number, currency = 'INR') {
    const o = this.orders.get(orderId)!;
    this.seq += 1;
    o.attempts.push({ providerPaymentId: `cfpay_${this.seq}`, status, amountPaise: amountPaise ?? o.amountPaise, currency, message: status === 'FAILED' ? 'Card declined' : undefined, at: new Date(Date.now() + this.seq) });
    if (status === 'SUCCESS') o.status = 'PAID';
  }
  /** A pending refund settles at the bank. */
  settleRefund(refundId: string, status: 'SUCCESS' | 'FAILED', arn: string | null = null) {
    const r = this.refunds.get(refundId)!;
    this.refunds.set(refundId, { ...r, status, providerStatus: status === 'SUCCESS' ? 'SUCCESS' : 'CANCELLED', arn });
  }
}

const prisma = new PrismaClient();
const cf = new FakeCashfree();
const WEBHOOK_SECRET = 'cf-pg-test-secret';
let restore: () => void;
let server: Server;
let base: string;
let variantId: string;
let sellerToken: string;
let seq = 0;

async function call<T = unknown>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

async function buyer() {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `92100${String(seq).padStart(5, '0')}`, name: `CF Buyer ${seq}`, referralCode: `CFB-${seq}` } });
  const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
  const address = await prisma.address.create({
    data: { userId: user.id, name: 'CF Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
  });
  return { user, token, address };
}

/** A shopper who has checked out one ₹800 item by UPI: a Cashfree order waiting for payment. */
async function placed() {
  const b = await buyer();
  expect((await call('POST', '/api/cart/items', b.token, { variantId, quantity: 1 })).status).toBe(200);
  const co = await call<CheckoutResult>('POST', '/api/orders/checkout', b.token, { addressId: b.address.id, paymentMethod: 'UPI' });
  expect(co.status).toBe(200);
  return { ...b, checkout: co.json.data };
}

const confirm = (token: string, kind: string, id: string) => call<PaymentConfirmResult>('POST', '/api/payments/confirm', token, { kind, id });
const stockOf = async () => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;

function signed(body: unknown, idempotencyKey?: string, signedAt = Date.now()) {
  const raw = JSON.stringify(body);
  const ts = String(signedAt);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(ts).update(raw).digest('base64');
  return { raw, headers: { 'x-webhook-timestamp': ts, 'x-webhook-signature': signature, ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}) } };
}

beforeAll(async () => {
  await seedFixture(prisma);
  await setSetting('codMinOrderPaise', 0);
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  sellerToken = signAccessToken({ sub: seller.userId, role: 'SELLER' });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, categoryId: category.id, title: 'Cashfree Flow Book', slug: 'cashfree-flow-book', description: 'For the Cashfree tests.', basePricePaise: 80_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  variantId = (
    await prisma.productVariant.create({
      data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-CF-FLOW', pricePaise: 80_000, stock: 500 },
    })
  ).id;
  restore = setPaymentProviderForTests(cf);
  (env as { CASHFREE_PG_CLIENT_SECRET?: string }).CASHFREE_PG_CLIENT_SECRET = WEBHOOK_SECRET;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  cf.nextRefund = [];
});

afterAll(async () => {
  restore();
  (env as { CASHFREE_PG_CLIENT_SECRET?: string }).CASHFREE_PG_CLIENT_SECRET = undefined;
  await setSetting('codMinOrderPaise', DEFAULT_SETTINGS.codMinOrderPaise);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a Cashfree checkout', () => {
  it('opens a Cashfree session for the order, which expires', async () => {
    const { checkout } = await placed();
    expect(checkout.payment).toMatchObject({ provider: 'cashfree', providerOrderId: checkout.orderNumber, paymentSessionId: `session_${checkout.orderNumber}`, mode: 'sandbox' });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } });
    expect(payment).toMatchObject({ provider: 'cashfree', status: 'CREATED', providerOrderId: checkout.orderNumber, paymentSessionId: `session_${checkout.orderNumber}`, settlementMode: 'payouts' });
    expect(payment.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it('a failed attempt is not the end: the order stays open, its stock held, and it can be paid again', async () => {
    const { token, checkout } = await placed();
    const stock = await stockOf();
    cf.attempt(checkout.orderNumber, 'FAILED');
    const r = await confirm(token, 'ORDER', checkout.orderId);
    expect(r.json.data).toMatchObject({ outcome: 'RETRY', message: 'The payment did not go through (Card declined).', checkout: { provider: 'cashfree', paymentSessionId: `session_${checkout.orderNumber}` } });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId }, include: { payment: true } });
    expect(order.status).toBe('PLACED');
    expect(order.payment!.status).toBe('CREATED');
    expect(await stockOf()).toBe(stock);

    cf.attempt(checkout.orderNumber, 'SUCCESS');
    expect((await confirm(token, 'ORDER', checkout.orderId)).json.data.outcome).toBe('PAID');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId } })).status).toBe('CONFIRMED');
  });

  it('a payment the bank has not decided is PENDING, and nothing happens to the order', async () => {
    const { token, checkout } = await placed();
    cf.attempt(checkout.orderNumber, 'PENDING');
    expect((await confirm(token, 'ORDER', checkout.orderId)).json.data.outcome).toBe('PENDING');
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).status).toBe('CREATED');
  });

  it('settles once when the page, a second tab and the webhook all arrive together', async () => {
    const { token, user, checkout } = await placed();
    cf.attempt(checkout.orderNumber, 'SUCCESS');
    const hook = signed({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: checkout.orderNumber } } });
    const results = await Promise.all([
      confirm(token, 'ORDER', checkout.orderId),
      confirm(token, 'ORDER', checkout.orderId),
      call('POST', '/api/payments/cashfree/webhook', null, hook.raw, hook.headers),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await prisma.creditLedger.count({ where: { userId: user.id, reason: 'EARN_PURCHASE' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: user.id, type: 'ORDER_CONFIRMED' } })).toBe(1);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } });
    expect(payment).toMatchObject({ status: 'PAID', providerPaymentId: expect.stringMatching(/^cfpay_/) });
  });

  it('never settles a payment for a different amount or currency, and flags it for a person', async () => {
    const { token, checkout } = await placed();
    cf.attempt(checkout.orderNumber, 'SUCCESS', 100);
    const r = await confirm(token, 'ORDER', checkout.orderId);
    expect(r.json.data.outcome).toBe('PENDING');
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).status).toBe('CREATED');
    // Written before the answer, not in the background.
    const flagged = await prisma.auditLog.findFirst({ where: { action: 'Payment amount mismatch', entityId: checkout.orderId } });
    expect(flagged).toMatchObject({ severity: 'CRITICAL' });
  });

  it('only shows a buyer their own payment', async () => {
    const { checkout } = await placed();
    const stranger = await buyer();
    expect((await confirm(stranger.token, 'ORDER', checkout.orderId)).status).toBe(404);
  });
});

describe('the Cashfree webhook', () => {
  it('refuses a body without a valid signature', async () => {
    const { checkout } = await placed();
    cf.attempt(checkout.orderNumber, 'SUCCESS');
    const hook = signed({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: checkout.orderNumber } } });
    const tampered = hook.raw.replace('PAYMENT_SUCCESS', 'PAYMENT_FAILED');
    expect((await call('POST', '/api/payments/cashfree/webhook', null, tampered, hook.headers)).status).toBe(401);
    expect((await call('POST', '/api/payments/cashfree/webhook', null, hook.raw, {})).status).toBe(401);
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).status).toBe('CREATED');
  });

  it('acts on what Cashfree says now, not on what the body claims', async () => {
    const { checkout } = await placed();
    // The body says success; the gateway says nothing was paid. Nothing is settled.
    const hook = signed({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: checkout.orderNumber }, payment: { payment_status: 'SUCCESS' } } });
    expect((await call('POST', '/api/payments/cashfree/webhook', null, hook.raw, hook.headers)).status).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).status).toBe('CREATED');
  });

  it('recognises a redelivery by its signed body — under the same or a new idempotency key — and handles it once', async () => {
    const { checkout } = await placed();
    cf.attempt(checkout.orderNumber, 'SUCCESS');
    const body = { type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: checkout.orderNumber } } };
    const hook = signed(body, `idem-${checkout.orderNumber}`);
    const first = await call<{ duplicate?: boolean }>('POST', '/api/payments/cashfree/webhook', null, hook.raw, hook.headers);
    const again = await call<{ duplicate?: boolean }>('POST', '/api/payments/cashfree/webhook', null, hook.raw, hook.headers);
    const newKey = await call<{ duplicate?: boolean }>('POST', '/api/payments/cashfree/webhook', null, hook.raw, { ...hook.headers, 'x-idempotency-key': 'replayed-under-a-new-key' });
    expect(first.status).toBe(200);
    expect(again.json).toMatchObject({ received: true, duplicate: true });
    expect(newKey.json).toMatchObject({ received: true, duplicate: true });
    expect(await prisma.gatewayWebhookEvent.count({ where: { provider: 'cashfree-pg', reference: checkout.orderNumber } })).toBe(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).status).toBe('PAID');
  });

  it('settles once when both webhooks tell of the same payment — the order’s notify_url (2023-08-01) and the dashboard endpoint (2026-01-01), each with its own body', async () => {
    const { user, checkout } = await placed();
    const sellerUserId = (await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } })).userId;
    const stock = await stockOf();
    cf.attempt(checkout.orderNumber, 'SUCCESS');
    const amount = checkout.amountPaise / 100;
    const v2023 = signed({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      event_time: new Date().toISOString(),
      data: { order: { order_id: checkout.orderNumber, order_amount: amount, order_currency: 'INR' }, payment: { cf_payment_id: 'cfpay_x', payment_status: 'SUCCESS', payment_amount: amount } },
    });
    const v2026 = signed({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      event_time: new Date().toISOString(),
      data: {
        order: { order_id: checkout.orderNumber, order_amount: amount, order_currency: 'INR', order_tags: null },
        payment: { cf_payment_id: 'cfpay_x', payment_status: 'SUCCESS', payment_amount: amount, payment_group: 'upi' },
        customer_details: { customer_id: user.id },
        payment_gateway_details: { gateway_name: 'CASHFREE' },
      },
    });
    const hook = (h: ReturnType<typeof signed>) => call('POST', '/api/payments/cashfree/webhook', null, h.raw, h.headers);
    // Together, then each again (Cashfree retries until it hears 200).
    expect((await Promise.all([hook(v2023), hook(v2026)])).map((r) => r.status)).toEqual([200, 200]);
    expect((await Promise.all([hook(v2023), hook(v2026)])).map((r) => r.status)).toEqual([200, 200]);

    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).status).toBe('PAID');
    expect(await stockOf()).toBe(stock);
    expect(await prisma.creditLedger.count({ where: { userId: user.id, reason: 'EARN_PURCHASE' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: user.id, type: 'ORDER_CONFIRMED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: sellerUserId, type: 'NEW_ORDER', body: { contains: checkout.orderNumber } } })).toBe(1);
    // Both deliveries were read and recorded, each once.
    expect(await prisma.gatewayWebhookEvent.count({ where: { provider: 'cashfree-pg', reference: checkout.orderNumber } })).toBe(2);
  });

  it('turns away a correctly signed event signed over an hour ago, or too far ahead', async () => {
    const { checkout } = await placed();
    cf.attempt(checkout.orderNumber, 'SUCCESS');
    const body = { type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: checkout.orderNumber } } };
    const old = signed(body, undefined, Date.now() - 61 * 60 * 1000);
    const ahead = signed(body, undefined, Date.now() + 10 * 60 * 1000);
    expect((await call('POST', '/api/payments/cashfree/webhook', null, old.raw, old.headers)).status).toBe(401);
    expect((await call('POST', '/api/payments/cashfree/webhook', null, ahead.raw, ahead.headers)).status).toBe(401);
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).status).toBe('CREATED');
    // The same event signed just now is handled.
    const fresh = signed(body);
    expect((await call('POST', '/api/payments/cashfree/webhook', null, fresh.raw, fresh.headers)).status).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).status).toBe('PAID');
  });
});

describe('unpaid orders', () => {
  const expire = (orderId: string) =>
    prisma.payment.update({ where: { orderId }, data: { expiresAt: new Date(Date.now() - 10 * 60_000), lastCheckedAt: null } });

  it('are stopped at the gateway and cancelled when their time is up, with the stock returned', async () => {
    const { checkout } = await placed();
    const stock = await stockOf();
    await expire(checkout.orderId);
    await sweepUnpaidGatewayPayments();
    expect(cf.orders.get(checkout.orderNumber)!.status).toBe('TERMINATED');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId }, include: { payment: true } });
    expect(order.status).toBe('CANCELLED');
    expect(order.payment!.status).toBe('FAILED');
    expect(await stockOf()).toBe(stock + 1);
  });

  it('are not cancelled while a payment is in flight, and are confirmed if it lands', async () => {
    const { checkout } = await placed();
    cf.attempt(checkout.orderNumber, 'PENDING');
    await expire(checkout.orderId);
    await sweepUnpaidGatewayPayments();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId } })).status).toBe('PLACED');
    cf.attempt(checkout.orderNumber, 'SUCCESS');
    await prisma.payment.update({ where: { orderId: checkout.orderId }, data: { lastCheckedAt: null } });
    await sweepUnpaidGatewayPayments();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId } })).status).toBe('CONFIRMED');
  });

  it('on a gateway that cannot be asked are given up on after an hour; COD orders are never touched', async () => {
    const { user } = await buyer();
    const mk = (provider: string, orderNumber: string) =>
      prisma.order.create({
        data: {
          orderNumber,
          userId: user.id,
          shipName: 'S',
          shipPhone: '9100000000',
          shipLine1: '1',
          shipCity: 'Pune',
          shipState: 'Maharashtra',
          shipPincode: '411001',
          subtotalPaise: 1000,
          totalPaise: 1000,
          paymentMethod: provider === 'cod' ? 'COD' : 'UPI',
          payment: { create: { provider, providerOrderId: `${provider}_${orderNumber}`, amountPaise: 1000, status: 'CREATED', createdAt: new Date(Date.now() - 2 * 60 * 60_000) } },
        },
      });
    const mock = await mk('mock', `CLW-SWEEP-M${seq}`);
    const cod = await mk('cod', `CLW-SWEEP-C${seq}`);
    await sweepUnpaidGatewayPayments();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: mock.id } })).status).toBe('CANCELLED');
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: cod.id } })).status).toBe('CREATED');
  });

  it('paid after they were cancelled are refunded in full, and the buyer told', async () => {
    const { token, user, checkout } = await placed();
    await expire(checkout.orderId);
    await sweepUnpaidGatewayPayments();
    // The bank completes a payment started before the order was stopped.
    cf.orders.get(checkout.orderNumber)!.status = 'ACTIVE';
    cf.attempt(checkout.orderNumber, 'SUCCESS');
    cf.nextRefund = ['PENDING'];
    const r = await confirm(token, 'ORDER', checkout.orderId);
    expect(r.json.data.outcome).toBe('FAILED');
    expect(r.json.data.message).toMatch(/refunded/);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId }, include: { payment: true, refunds: true } });
    expect(order.status).toBe('CANCELLED');
    expect(order.refunds).toHaveLength(1);
    expect(order.refunds[0]).toMatchObject({ amountPaise: checkout.amountPaise, status: 'PROCESSING', provider: 'cashfree' });
    expect(await prisma.notification.count({ where: { userId: user.id, title: 'Payment refunded' } })).toBe(1);

    // A second webhook for the same payment does not refund again.
    const hook = signed({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: checkout.orderNumber } } });
    await call('POST', '/api/payments/cashfree/webhook', null, hook.raw, hook.headers);
    expect(await prisma.refund.count({ where: { orderId: checkout.orderId } })).toBe(1);
  });
});

describe('Cashfree refunds', () => {
  /** A paid order, cancelled by its buyer: refunded through Cashfree. */
  async function cancelledPaid(next: Array<GatewayRefund['status'] | 'THROW_UNCERTAIN'>) {
    const p = await placed();
    cf.attempt(p.checkout.orderNumber, 'SUCCESS');
    await confirm(p.token, 'ORDER', p.checkout.orderId);
    cf.nextRefund = next;
    const res = await call('POST', `/api/orders/${p.checkout.orderId}/cancel`, p.token, { reason: 'CHANGED_MIND' });
    expect(res.status).toBe(200);
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: p.checkout.orderId } });
    return { ...p, refund };
  }

  it('are accepted first and settled later: PROCESSING, then PROCESSED with the bank reference', async () => {
    const { checkout, refund } = await cancelledPaid(['PENDING']);
    expect(refund).toMatchObject({ status: 'PROCESSING', providerStatus: 'PENDING', provider: 'cashfree' });
    expect(cf.refundCalls.at(-1)).toMatchObject({ providerOrderId: checkout.orderNumber, refundId: refund.id, amountPaise: checkout.amountPaise });

    cf.settleRefund(refund.id, 'SUCCESS', 'ARN0001');
    const hook = signed({ type: 'REFUND_STATUS_WEBHOOK', data: { refund: { refund_id: refund.id, order_id: checkout.orderNumber } } });
    expect((await call('POST', '/api/payments/cashfree/webhook', null, hook.raw, hook.headers)).status).toBe(200);
    const after = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(after).toMatchObject({ status: 'PROCESSED', arn: 'ARN0001' });
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).status).toBe('REFUNDED');
  });

  it('that the bank turns down are FAILED, the admins are told, and an admin retry is a new gateway refund', async () => {
    await prisma.user.upsert({ where: { phone: '9219999999' }, update: {}, create: { phone: '9219999999', name: 'CF Admin', role: 'ADMIN', referralCode: 'CF-ADMIN' } });
    const { refund, checkout } = await cancelledPaid(['PENDING']);
    cf.settleRefund(refund.id, 'FAILED');
    await prisma.refund.update({ where: { id: refund.id }, data: { lastCheckedAt: null } });
    await pollProcessingRefunds();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('FAILED');
    await vi.waitFor(async () =>
      expect(await prisma.notification.count({ where: { type: 'ADMIN_REFUND_FAILED', title: `Refund failed: ${checkout.orderNumber}` } })).toBeGreaterThan(0),
    );

    cf.nextRefund = ['SUCCESS'];
    const after = await retryRefund(refund.id);
    expect(after.status).toBe('PROCESSED');
    expect(cf.refundCalls.at(-1)!.refundId).toBe(`${refund.id}R1`);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).attempts).toBe(1);
  });

  it('with no answer at all stay PROCESSING, and are sent again — as the same refund — only if Cashfree never got them', async () => {
    const { refund } = await cancelledPaid(['THROW_UNCERTAIN']);
    expect(refund).toMatchObject({ status: 'PROCESSING', providerStatus: 'UNCONFIRMED' });
    cf.nextRefund = ['SUCCESS'];
    await prisma.refund.update({ where: { id: refund.id }, data: { lastCheckedAt: null } });
    await pollProcessingRefunds();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('PROCESSED');
    const sent = cf.refundCalls.filter((c) => c.refundId === refund.id);
    expect(sent).toHaveLength(2);
  });
});

describe('top-ups through Cashfree', () => {
  it('a shopper’s credits are granted once, however many times the payment is confirmed', async () => {
    const { token, user } = await buyer();
    const pack = (await call<{ id: string }[]>('GET', '/api/credits/packages', token)).json.data[0]!;
    const purchase = (await call<CreditPurchaseResult>('POST', '/api/credits/purchase', token, { packageId: pack.id })).json.data;
    expect(purchase.payment).toMatchObject({ provider: 'cashfree', paymentSessionId: expect.any(String) });
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).creditsBalance;
    cf.attempt(purchase.payment.providerOrderId, 'SUCCESS');
    const both = await Promise.all([confirm(token, 'CREDITS', purchase.purchaseId), confirm(token, 'CREDITS', purchase.purchaseId)]);
    expect(both.map((r) => r.json.data.outcome)).toEqual(['PAID', 'PAID']);
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).creditsBalance;
    expect(after - before).toBe(purchase.credits + purchase.bonusCredits);
    expect(await prisma.creditLedger.count({ where: { userId: user.id, reason: 'EARN_TOPUP' } })).toBe(1);
  });

  it('a seller’s wallet is credited once, and a top-up that failed in time is still honoured if paid', async () => {
    const purchase = (await call<PromotionCreditPurchaseResult>('POST', '/api/seller/promotion-credits/purchase', sellerToken, { amountPaise: 50_000 })).json.data;
    expect(purchase.payment.provider).toBe('cashfree');
    // Marked FAILED by the sweeper before the bank confirmed it…
    await prisma.promotionCreditPurchase.update({ where: { id: purchase.purchaseId }, data: { expiresAt: new Date(Date.now() - 10 * 60_000) } });
    await sweepUnpaidGatewayPayments();
    expect((await prisma.promotionCreditPurchase.findUniqueOrThrow({ where: { id: purchase.purchaseId } })).status).toBe('FAILED');
    // …then it lands: the money was taken, so the wallet gets it.
    cf.orders.get(purchase.payment.providerOrderId)!.status = 'ACTIVE';
    cf.attempt(purchase.payment.providerOrderId, 'SUCCESS');
    expect((await confirm(sellerToken, 'PROMOTION', purchase.purchaseId)).json.data.outcome).toBe('PAID');
    expect((await confirm(sellerToken, 'PROMOTION', purchase.purchaseId)).json.data.outcome).toBe('PAID');
    expect(await prisma.sellerLedgerEntry.count({ where: { purchaseId: purchase.purchaseId, type: 'PROMOTION_CREDIT_PURCHASE' } })).toBe(1);
  });
});
