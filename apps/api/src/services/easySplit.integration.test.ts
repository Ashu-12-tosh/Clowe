import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutResult } from '@clowe/shared';
import { createApp } from '../app';
import { env } from '../env';
import { seedFixture } from '../test/fixture';
import { verifiedPan } from '../test/kyc';
import { signAccessToken } from '../utils/jwt';
import { DEFAULT_SETTINGS, setSetting } from './settingsService';
import { setPaymentProviderForTests } from './payments';
import { GatewayError, type CreateGatewayOrderInput, type GatewayOrder, type GatewayOrderState, type GatewayRefund, type GatewayRefundInput, type PaymentProvider } from './payments/PaymentProvider';
import { balance, postDeliveryEntries } from './sellerLedgerService';
import { ensureVendor, releaseDueSplits, setEasySplitActiveForTests, setEasySplitClientForTests, vendorIdFor } from './easySplit';
import type { CashfreeEasySplitClient, VendorInput } from './cashfree/easySplitClient';
import { refundOrderPart } from './refundService';

/**
 * Easy Split: each seller's share travels with the payment to their Cashfree
 * vendor account, is held there, and is released once the seller's lines are
 * past the hold and return window. The seller ledger records it as paid via
 * Cashfree, so a Clowe payout never pays it again; a refund takes the
 * vendor's part back from the vendor.
 */

class SplitGateway implements PaymentProvider {
  readonly name = 'cashfree' as const;
  readonly mode = 'sandbox' as const;
  created: CreateGatewayOrderInput[] = [];
  refunds: GatewayRefundInput[] = [];
  refuseSplits = false;
  paid = new Set<string>();
  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    if (input.splits?.length && this.refuseSplits) throw new GatewayError('Easy Split is not enabled', 400, 'feature_not_enabled');
    this.created.push(input);
    return { providerOrderId: input.receipt, paymentSessionId: `s_${input.receipt}`, expiresAt: input.expiresAt };
  }
  verifySignature() {
    return false;
  }
  async fetchOrder(id: string): Promise<GatewayOrderState> {
    const o = this.created.find((c) => c.receipt === id)!;
    const paid = this.paid.has(id);
    return { status: paid ? 'PAID' : 'ACTIVE', amountPaise: o.amountPaise, currency: 'INR', attempts: paid ? [{ providerPaymentId: `p_${id}`, status: 'SUCCESS', amountPaise: o.amountPaise, currency: 'INR' }] : [] };
  }
  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    this.refunds.push(input);
    return { providerRefundId: `r_${input.refundId}`, status: 'SUCCESS', providerStatus: 'SUCCESS' };
  }
}

/** Stands in for Cashfree's Easy Split API. */
function stubClient() {
  const calls = { created: [] as VendorInput[], released: [] as { orderId: string; vendorId: string }[] };
  const client = {
    async createVendor(v: VendorInput) {
      calls.created.push(v);
      return 'IN_BENE_CREATION';
    },
    async vendorStatus() {
      return 'ACTIVE';
    },
    async orderShares() {
      return [];
    },
    async release(orderId: string, vendorId: string) {
      calls.released.push({ orderId, vendorId });
    },
  } as unknown as CashfreeEasySplitClient;
  return { client, calls };
}

const prisma = new PrismaClient();
const gateway = new SplitGateway();
const stub = stubClient();
let restore: () => void;
let server: Server;
let base: string;
let sellerId: string;
let variantId: string;
let seq = 0;

async function call<T = unknown>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string } } };
}

async function checkout() {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `94100${String(seq).padStart(5, '0')}`, name: `Split Buyer ${seq}`, referralCode: `ES-B-${seq}` } });
  const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
  const address = await prisma.address.create({ data: { userId: user.id, name: 'B', phone: user.phone, line1: '1 Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true } });
  expect((await call('POST', '/api/cart/items', token, { variantId, quantity: 1 })).status).toBe(200);
  const co = await call<CheckoutResult>('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: 'UPI' });
  expect(co.status).toBe(200);
  return { token, ...co.json.data };
}

/** Pay it, and confirm with the server. */
async function pay(o: { token: string; orderId: string; orderNumber: string }) {
  gateway.paid.add(o.orderNumber);
  const r = await call<{ outcome: string }>('POST', '/api/payments/confirm', o.token, { kind: 'ORDER', id: o.orderId });
  expect(r.json.data.outcome).toBe('PAID');
}

async function deliver(orderId: string, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  const items = await prisma.orderItem.findMany({ where: { orderId } });
  for (const i of items) {
    await prisma.orderItem.update({ where: { id: i.id }, data: { status: 'DELIVERED', shippedAt: at, deliveredAt: at } });
    await postDeliveryEntries(i.id);
  }
  return items;
}

beforeAll(async () => {
  await seedFixture(prisma);
  // The fixture's shop, which shoppers can buy from, with a verified PAN and bank account.
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  await prisma.user.update({ where: { id: seller.userId }, data: { email: 'split.seller@example.com' } });
  sellerId = seller.id;
  await verifiedPan(sellerId, 'ABCDE1234F', 'Split Seller');
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({ data: { sellerId, categoryId: category.id, title: 'Split Book', slug: 'split-book', description: 'Easy Split tests.', basePricePaise: 100_000, status: ProductStatus.APPROVED, approvedAt: new Date() } });
  variantId = (await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-SPLIT', pricePaise: 100_000, stock: 100 } })).id;
  await setSetting('codMinOrderPaise', 0);
  restore = setPaymentProviderForTests(gateway);
  setEasySplitActiveForTests(true);
  setEasySplitClientForTests(stub.client);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  restore();
  setEasySplitActiveForTests(false);
  setEasySplitClientForTests(null);
  await setSetting('codMinOrderPaise', DEFAULT_SETTINGS.codMinOrderPaise);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('vendors', () => {
  it('are created for an approved seller with a verified PAN and bank account — without Cashfree re-checking the account', async () => {
    const status = await ensureVendor(sellerId);
    expect(status).toBe('IN_BENE_CREATION');
    expect(stub.calls.created.at(-1)).toMatchObject({
      vendorId: vendorIdFor(sellerId),
      email: 'split.seller@example.com',
      pan: 'ABCDE1234F',
      bank: { accountNumber: '1234567890', ifsc: 'HDFC0001234' },
      accountType: 'BUSINESS',
    });
    expect(await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } })).toMatchObject({ cashfreeVendorId: vendorIdFor(sellerId), cashfreeVendorStatus: 'IN_BENE_CREATION' });
    // Next time it is only read.
    expect(await ensureVendor(sellerId)).toBe('ACTIVE');
    expect(stub.calls.created).toHaveLength(1);
  });
});

describe('a split order', () => {
  it('is not split while the seller’s vendor is not ACTIVE', async () => {
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { cashfreeVendorStatus: 'IN_BENE_CREATION' } });
    const o = await checkout();
    expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: o.orderId } })).settlementMode).toBe('payouts');
    expect(gateway.created.at(-1)!.splits).toBeUndefined();
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { cashfreeVendorStatus: 'ACTIVE' } });
  });

  it('sends the seller’s share with the payment, and records it per line', async () => {
    const o = await checkout();
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: o.orderId }, include: { splits: true } });
    expect(payment.settlementMode).toBe('easy_split');
    expect(payment.splits).toHaveLength(1);
    const share = payment.splits[0]!.amountPaise;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(o.amountPaise);
    expect(gateway.created.at(-1)!.splits).toEqual([{ vendorId: vendorIdFor(sellerId), amountPaise: share }]);
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.orderId } });
    expect(line.easySplitPaise).toBe(share);
  });

  it('falls back to collecting into Clowe’s account when Cashfree refuses the split', async () => {
    gateway.refuseSplits = true;
    try {
      const o = await checkout();
      expect((await prisma.payment.findUniqueOrThrow({ where: { orderId: o.orderId } })).settlementMode).toBe('payouts');
      expect(gateway.created.at(-1)!.splits).toBeUndefined();
    } finally {
      gateway.refuseSplits = false;
    }
  });

  it('once delivered, is in the ledger as paid via Cashfree, so a payout never pays the share again', async () => {
    const before = await balance(sellerId, 'SETTLEMENT');
    const o = await checkout();
    await pay(o);
    const [line] = await deliver(o.orderId, 0);
    const share = (await prisma.orderItem.findUniqueOrThrow({ where: { id: line!.id } })).easySplitPaise!;
    const entry = await prisma.sellerLedgerEntry.findFirstOrThrow({ where: { orderItemId: line!.id, type: 'EASY_SPLIT_SHARE' } });
    expect(entry.amountPaise).toBe(-share);
    // The sale less Clowe's charges and taxes is exactly the share: nothing left for a payout.
    expect((await balance(sellerId, 'SETTLEMENT')) - before).toBe(0);
  });

  it('is released after the hold and return window, and marked settled when Cashfree pays the vendor', async () => {
    const o = await checkout();
    await pay(o);
    await deliver(o.orderId, 30);
    const r = await releaseDueSplits();
    expect(r.released).toBeGreaterThanOrEqual(1);
    expect(stub.calls.released).toContainEqual({ orderId: o.orderNumber, vendorId: vendorIdFor(sellerId) });
    const split = await prisma.paymentSplit.findFirstOrThrow({ where: { payment: { orderId: o.orderId } } });
    expect(split.status).toBe('RELEASED');

    // Cashfree's vendor settlement webhook.
    (env as { CASHFREE_PG_CLIENT_SECRET?: string }).CASHFREE_PG_CLIENT_SECRET = 'split-secret';
    try {
      const raw = JSON.stringify({ type: 'VENDOR_SETTLEMENT_SUCCESS', data: { vendor_id: vendorIdFor(sellerId), utr: 'VUTR1', status: 'SUCCESS' } });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', 'split-secret').update(ts).update(raw).digest('base64');
      expect((await call('POST', '/api/payments/cashfree/webhook', null, raw, { 'x-webhook-timestamp': ts, 'x-webhook-signature': sig })).status).toBe(200);
    } finally {
      (env as { CASHFREE_PG_CLIENT_SECRET?: string }).CASHFREE_PG_CLIENT_SECRET = undefined;
    }
    expect(await prisma.paymentSplit.findUniqueOrThrow({ where: { id: split.id } })).toMatchObject({ status: 'SETTLED', utr: 'VUTR1' });
  });

  it('is not released while a line is still inside its return window', async () => {
    const o = await checkout();
    await pay(o);
    await deliver(o.orderId, 1);
    await releaseDueSplits();
    expect((await prisma.paymentSplit.findFirstOrThrow({ where: { payment: { orderId: o.orderId } } })).status).toBe('HELD');
  });

  it('that outlived the deferral is settled to Clowe instead, and the seller paid by payout', async () => {
    const o = await checkout();
    await pay(o);
    await deliver(o.orderId, 1);
    await prisma.payment.update({ where: { orderId: o.orderId }, data: { paidAt: new Date(Date.now() - 47 * 86_400_000) } });
    const before = await balance(sellerId, 'SETTLEMENT');
    const r = await releaseDueSplits();
    expect(r.lapsed).toBeGreaterThanOrEqual(1);
    const split = await prisma.paymentSplit.findFirstOrThrow({ where: { payment: { orderId: o.orderId } } });
    expect(split.status).toBe('LAPSED');
    expect((await balance(sellerId, 'SETTLEMENT')) - before).toBe(split.amountPaise);
  });

  it('cancelled before delivery: the refund takes the vendor’s share back from the vendor', async () => {
    const o = await checkout();
    await pay(o);
    const split = await prisma.paymentSplit.findFirstOrThrow({ where: { payment: { orderId: o.orderId } } });
    await prisma.orderItem.updateMany({ where: { orderId: o.orderId }, data: { status: 'CANCELLED' } });
    const refund = await refundOrderPart(o.orderId, o.amountPaise, 'Seller cancelled');
    expect(refund?.status).toBe('PROCESSED');
    expect(gateway.refunds.at(-1)!.splits).toEqual([{ vendorId: vendorIdFor(sellerId), amountPaise: split.amountPaise }]);
    expect((await prisma.paymentSplit.findUniqueOrThrow({ where: { id: split.id } })).refundedPaise).toBe(split.amountPaise);
    await releaseDueSplits();
    expect((await prisma.paymentSplit.findUniqueOrThrow({ where: { id: split.id } })).status).toBe('CLAWED_BACK');
  });
});
