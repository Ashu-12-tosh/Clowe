import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS } from '../services/settingsService';
import { balance } from '../services/sellerLedgerService';
import { availableBalance } from '../services/payoutService';
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

const CATEGORY_7_DAYS = DEFAULT_SETTINGS.adPricing.CATEGORY_SPONSORED['7']; // ₹299
const HOME_30_DAYS = DEFAULT_SETTINGS.adPricing.HOME_BANNER['30']; // ₹1,499

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

async function makeAdmin() {
  seq += 1;
  const admin = await prisma.user.create({
    data: { phone: `92900${String(seq).padStart(5, '0')}`, name: `Promo Admin ${seq}`, role: Role.ADMIN, referralCode: `PRM-A-${seq}` },
  });
  return signAccessToken({ sub: admin.id, role: 'ADMIN' });
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

const bookAd = (token: string, productId: string, placement = 'CATEGORY_SPONSORED', durationDays = 7) =>
  call('POST', '/api/seller/ads', token, { productId, placement, durationDays });

async function both(sellerId: string) {
  return { promotion: await balance(sellerId, 'PROMOTION'), settlement: await balance(sellerId, 'SETTLEMENT') };
}

// ---------------------------------------------------------------------------

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

describe('spending credits', () => {
  it('deducts the placement price when an ad is booked', async () => {
    const s = await makeSeller();
    await topUp(s.token, 100_000);
    const booked = await bookAd(s.token, s.productId);
    expect(booked.status).toBe(200);
    const { id } = booked.json.data as { id: string };

    expect(await both(s.sellerId)).toEqual({ promotion: 100_000 - CATEGORY_7_DAYS, settlement: 0 });
    const spend = await prisma.sellerLedgerEntry.findUnique({ where: { adId_type: { adId: id, type: 'PROMOTION_CREDIT_SPEND' } } });
    expect(spend?.amountPaise).toBe(-CATEGORY_7_DAYS);
    expect(spend?.bucket).toBe('PROMOTION');
  });

  it('refuses an ad the balance cannot cover, and books nothing', async () => {
    const s = await makeSeller();
    await topUp(s.token, 50_000); // ₹500, well short of the ₹1,499 home banner
    const refused = await bookAd(s.token, s.productId, 'HOME_BANNER', 30);
    expect(refused.status).toBe(400);
    expect(refused.json.error?.code).toBe('INSUFFICIENT_PROMOTION_BALANCE');
    expect(refused.json.error?.message).toContain('₹1,499');
    expect(await prisma.ad.count({ where: { sellerId: s.sellerId } })).toBe(0);
    expect(await both(s.sellerId)).toEqual({ promotion: 50_000, settlement: 0 });
    expect(HOME_30_DAYS).toBeGreaterThan(50_000);
  });

  it('refuses with no balance at all', async () => {
    const s = await makeSeller();
    const refused = await bookAd(s.token, s.productId);
    expect(refused.status).toBe(400);
    expect(refused.json.error?.code).toBe('INSUFFICIENT_PROMOTION_BALANCE');
  });

  it('gives the credits back when the ad is declined, once', async () => {
    const s = await makeSeller();
    const admin = await makeAdmin();
    await topUp(s.token, 100_000);
    const { id } = (await bookAd(s.token, s.productId)).json.data as { id: string };
    expect(await balance(s.sellerId, 'PROMOTION')).toBe(100_000 - CATEGORY_7_DAYS);

    const declined = await call('PATCH', `/api/admin/ads/${id}`, admin, { action: 'reject', reason: 'Image is too dark to read' });
    expect(declined.status).toBe(200);
    expect(await balance(s.sellerId, 'PROMOTION')).toBe(100_000);

    // Deciding again is refused by status, and the refund pair would refuse too.
    const again = await call('PATCH', `/api/admin/ads/${id}`, admin, { action: 'reject', reason: 'Still too dark' });
    expect(again.status).toBe(400);
    expect(await balance(s.sellerId, 'PROMOTION')).toBe(100_000);
  });

  it('is not recovered from payouts a second time', async () => {
    const s = await makeSeller();
    const admin = await makeAdmin();
    await topUp(s.token, 100_000);
    const { id } = (await bookAd(s.token, s.productId)).json.data as { id: string };
    await call('PATCH', `/api/admin/ads/${id}`, admin, { action: 'approve' });

    // An ACTIVE ad used to be "outstanding ad spend" that a payout clawed back.
    const available = await availableBalance(s.sellerId);
    expect(available.adjustmentsPaise).toBe(0);
  });
});

describe('the two buckets', () => {
  it('never move each other', async () => {
    const s = await makeSeller();
    await topUp(s.token, 200_000);
    await bookAd(s.token, s.productId);
    await topUp(s.token, 30_000);
    expect(await both(s.sellerId)).toEqual({ promotion: 230_000 - CATEGORY_7_DAYS, settlement: 0 });

    const settlementPage = await call('GET', '/api/seller/ledger?bucket=SETTLEMENT', s.token);
    expect((settlementPage.json.data as { total: number }).total).toBe(0);
    const promotionPage = await call('GET', '/api/seller/ledger?bucket=PROMOTION', s.token);
    const promo = promotionPage.json.data as { total: number; balancePaise: number; rows: { type: string }[] };
    expect(promo.total).toBe(3);
    expect(promo.balancePaise).toBe(230_000 - CATEGORY_7_DAYS);
    expect(promo.rows.map((r) => r.type)).toEqual(['PROMOTION_CREDIT_PURCHASE', 'PROMOTION_CREDIT_SPEND', 'PROMOTION_CREDIT_PURCHASE']);
  });
});
