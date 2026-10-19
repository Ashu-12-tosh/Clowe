import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { balance } from '../services/sellerLedgerService';
import { signAccessToken } from '../utils/jwt';

/**
 * Promotion credits: prepaid, spent on placements, never paid out.
 *
 * A top-up credits the PROMOTION bucket once the gateway settles it (once,
 * by the (purchaseId, type) pair); booking an ad spends from it inside the
 * same transaction as the booking, and is refused outright when the balance
 * is short; a declined ad gives the credits back. And whatever happens in
 * that bucket, the SETTLEMENT balance — the one a payout draws on — does
 * not move.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
let seq = 0;


beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirst({ where: { isActive: true } });
  if (!category) throw new Error('fixture produced no active category');
  categoryId = category.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function makeSeller() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `92000${String(seq).padStart(5, '0')}`, name: `Promo Seller ${seq}`, role: Role.SELLER, referralCode: `PRM-S-${seq}` },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Promo Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      categoryId,
      title: `Promo Product ${seq}`,
      slug: `promo-product-${seq}`,
      description: 'Used by the promotion credit regression tests.',
      basePricePaise: 100_000,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
    },
  });
  return { sellerId: seller.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }), productId: product.id };
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: never; error?: { code: string; message: string } };
  return { status: res.status, json };
}

/** Start and settle a top-up through the dev gateway. */
async function topUp(token: string, amountPaise: number, outcome: 'success' | 'failure' = 'success') {
  const started = await call('POST', '/api/seller/promotion-credits/purchase', token, { amountPaise });
  expect(started.status).toBe(200);
  const { purchaseId } = started.json.data as { purchaseId: string };
  const settled = await call('POST', `/api/seller/promotion-credits/purchase/${purchaseId}/mock-pay`, token, { outcome });
  return { purchaseId, settled };
}

async function both(sellerId: string) {
  return { promotion: await balance(sellerId, 'PROMOTION'), settlement: await balance(sellerId, 'SETTLEMENT') };
}

// ---------------------------------------------------------------------------

// Pre-launch audit (2026-10-20): the mock gateway answered "valid" to any
// signature, so /verify marked any order (or top-up) paid for free — on
// production too, which runs the mock until Cashfree goes live.
describe('a forged gateway callback settles nothing', () => {
  const forged = { razorpayPaymentId: 'pay_forged', razorpaySignature: 'not-a-signature' };

  it('refuses /api/payments/verify for an order awaiting payment', async () => {
    seq += 1;
    const user = await prisma.user.create({ data: { phone: `92001${String(seq).padStart(5, '0')}`, name: `Verify Buyer ${seq}`, referralCode: `PRM-B-${seq}` } });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        orderNumber: `CLW-2026-${String(870000 + seq)}`,
        status: 'PLACED',
        subtotalPaise: 50_000,
        shippingPaise: 0,
        totalPaise: 50_000,
        shipName: 'Verify Buyer',
        shipPhone: '9500000001',
        shipLine1: '1 Test Street',
        shipCity: 'Mumbai',
        shipState: 'Maharashtra',
        shipPincode: '400001',
        payment: { create: { provider: 'mock', providerOrderId: `mock_order_verify_${seq}`, amountPaise: 50_000 } },
      },
    });
    const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
    const r = await call('POST', '/api/payments/verify', token, { orderId: order.id, razorpayOrderId: `mock_order_verify_${seq}`, ...forged });
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe('SIGNATURE_FLOW_UNAVAILABLE');
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } });
    expect(after.status).toBe('PLACED');
    expect(after.payment?.status).toBe('CREATED');
    await prisma.order.delete({ where: { id: order.id } });
  });

  it('refuses a seller top-up’s /verify, and the wallet stays empty', async () => {
    const s = await makeSeller();
    const started = await call('POST', '/api/seller/promotion-credits/purchase', s.token, { amountPaise: 100_000 });
    const { purchaseId } = started.json.data as { purchaseId: string };
    const purchase = await prisma.promotionCreditPurchase.findUniqueOrThrow({ where: { id: purchaseId } });
    const r = await call('POST', `/api/seller/promotion-credits/purchase/${purchaseId}/verify`, s.token, { razorpayOrderId: purchase.providerOrderId, ...forged });
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe('SIGNATURE_FLOW_UNAVAILABLE');
    expect(await balance(s.sellerId, 'PROMOTION')).toBe(0);
  });

  it('the mock gateway vouches for no signature', async () => {
    const { MockPaymentProvider } = await import('../services/payments/MockPaymentProvider');
    expect(new MockPaymentProvider().verifySignature()).toBe(false);
  });
});

describe('buying credits', () => {
  it('adds the amount once the payment settles, and never before', async () => {
    const s = await makeSeller();
    const started = await call('POST', '/api/seller/promotion-credits/purchase', s.token, { amountPaise: 100_000 });
    expect(started.status).toBe(200);
    expect(await balance(s.sellerId, 'PROMOTION')).toBe(0);

    const { purchaseId } = started.json.data as { purchaseId: string };
    const settled = await call('POST', `/api/seller/promotion-credits/purchase/${purchaseId}/mock-pay`, s.token, { outcome: 'success' });
    expect(settled.status).toBe(200);
    expect((settled.json.data as { status: string; balancePaise: number }).balancePaise).toBe(100_000);
    expect(await both(s.sellerId)).toEqual({ promotion: 100_000, settlement: 0 });
  });

  it('credits nothing on a failed payment or a replayed settle', async () => {
    const s = await makeSeller();
    const failed = await topUp(s.token, 50_000, 'failure');
    expect((failed.settled.json.data as { status: string }).status).toBe('FAILED');
    expect(await balance(s.sellerId, 'PROMOTION')).toBe(0);

    const paid = await topUp(s.token, 50_000);
    expect(await balance(s.sellerId, 'PROMOTION')).toBe(50_000);
    const again = await call('POST', `/api/seller/promotion-credits/purchase/${paid.purchaseId}/mock-pay`, s.token, { outcome: 'success' });
    expect(again.status).toBe(400);
    expect(again.json.error?.code).toBe('PURCHASE_SETTLED');
    expect(await balance(s.sellerId, 'PROMOTION')).toBe(50_000);
  });

  it('refuses a top-up under the minimum', async () => {
    const s = await makeSeller();
    const { status } = await call('POST', '/api/seller/promotion-credits/purchase', s.token, { amountPaise: 5_000 });
    expect(status).toBe(400);
  });
});

describe('the two buckets', () => {
  it('never move each other', async () => {
    const s = await makeSeller();
    await topUp(s.token, 200_000);
    await topUp(s.token, 30_000);
    expect(await both(s.sellerId)).toEqual({ promotion: 230_000, settlement: 0 });

    const settlementPage = await call('GET', '/api/seller/ledger?bucket=SETTLEMENT', s.token);
    expect((settlementPage.json.data as { total: number }).total).toBe(0);
    const promotionPage = await call('GET', '/api/seller/ledger?bucket=PROMOTION', s.token);
    const promo = promotionPage.json.data as { total: number; balancePaise: number; rows: { type: string }[] };
    expect(promo.total).toBe(2);
    expect(promo.balancePaise).toBe(230_000);
    expect(promo.rows.map((r) => r.type)).toEqual(['PROMOTION_CREDIT_PURCHASE', 'PROMOTION_CREDIT_PURCHASE']);
  });

  it('the old ad booking points to Advertising', async () => {
    const s = await makeSeller();
    const moved = await call('POST', '/api/seller/ads', s.token, { productId: s.productId, placement: 'CATEGORY_SPONSORED', durationDays: 7 });
    expect(moved.status).toBe(410);
    expect(moved.json.error?.code).toBe('ADS_MOVED');
  });
});
