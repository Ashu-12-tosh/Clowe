import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { verifiedPan } from '../test/kyc';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { invalidateCategoryRules } from '../services/categoryRules';
import {
  balance,
  postDeliveryEntries,
  postEntry,
  postReturnReversal,
} from '../services/sellerLedgerService';
import { signAccessToken } from '../utils/jwt';

/**
 * The seller ledger: one signed row per money event, balance = SUM.
 *
 * What these pin: a delivery posts its earning and deductions exactly once no
 * matter how often the line is replayed (the unique pair on the table, not a
 * check someone has to remember), a payout posts the transfer, a return undoes
 * the delivery, the two buckets never bleed into each other, and the payout
 * page reads "available" from the ledger rather than a recomputation.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
let seq = 0;

// A ₹3,000 sale (what the buyer paid). The fixture category carries no GST
// rule, so the standard 18% applies: ₹2,542.37 is the seller's price before
// GST, the base for the 10% commission, TDS 0.1% and TCS 0.5%. The 2% gateway
// is on the ₹3,000 the buyer paid. Plus the default fixed fees.
const PRICE = 300_000;
const COMMISSION = 25_424;
const GATEWAY = 6_000;
const TDS = 254;
const TCS = 1_271;
const PLATFORM = DEFAULT_SETTINGS.platformFeePaise;
const DELIVERY = DEFAULT_SETTINGS.deliveryFeePaise;
const CLOSING = DEFAULT_SETTINGS.closingFeePaise;
const GT = DEFAULT_SETTINGS.gtChargePaise;
const FIXED = PLATFORM + DELIVERY + CLOSING + GT;
const NET = PRICE - COMMISSION - GATEWAY - TDS - TCS - FIXED;
/** Entries one delivered unit posts. */
const ENTRIES_PER_DELIVERY = 9;

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirst({ where: { isActive: true } });
  if (!category) throw new Error('fixture produced no active category');
  categoryId = category.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await setSetting('payoutHoldDays', DEFAULT_SETTINGS.payoutHoldDays);
  await setSetting('payoutCommissionPercent', DEFAULT_SETTINGS.payoutCommissionPercent);
  await setSetting('platformFeePaise', DEFAULT_SETTINGS.platformFeePaise);
  await setSetting('deliveryFeePaise', DEFAULT_SETTINGS.deliveryFeePaise);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** An approved seller with one product, plus a shopper to buy it. */
async function makeSeller() {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `94000${String(seq).padStart(5, '0')}`,
      name: `Ledger Seller ${seq}`,
      role: Role.SELLER,
      referralCode: `LDG-S-${seq}`,
    },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Ledger Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      categoryId,
      title: `Ledger Product ${seq}`,
      slug: `ledger-product-${seq}`,
      description: 'Used by the seller ledger regression tests.',
      basePricePaise: PRICE,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      optionValues: { size: 'M' },
      optionsKey: 'size:M',
      label: 'M',
      size: 'M',
      color: '',
      sku: `SKU-LDG-${seq}`,
      pricePaise: PRICE,
      stock: 50,
    },
  });
  const shopper = await prisma.user.create({
    data: { phone: `95000${String(seq).padStart(5, '0')}`, name: `Ledger Shopper ${seq}`, referralCode: `LDG-U-${seq}` },
  });
  return {
    sellerId: seller.id,
    token: signAccessToken({ sub: user.id, role: 'SELLER' }),
    product,
    variant,
    shopperId: shopper.id,
  };
}

/** One confirmed order holding one line for this seller, at the given stage. */
async function makeLine(
  s: Awaited<ReturnType<typeof makeSeller>>,
  status: 'CONFIRMED' | 'SHIPPED' | 'DELIVERED',
  opts: { quantity?: number; deliveredAt?: Date } = {},
) {
  seq += 1;
  const quantity = opts.quantity ?? 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: `CLW-LDG-${String(seq).padStart(6, '0')}`,
      userId: s.shopperId,
      shipName: 'Ledger Shopper',
      shipPhone: '9500000000',
      shipLine1: '1 Test Lane',
      shipCity: 'Mumbai',
      shipState: 'Maharashtra',
      shipPincode: '400001',
      status: status === 'CONFIRMED' ? 'CONFIRMED' : status,
      subtotalPaise: PRICE * quantity,
      totalPaise: PRICE * quantity,
      paymentMethod: 'UPI',
      payment: { create: { provider: 'mock', amountPaise: PRICE * quantity, status: 'PAID' } },
    },
  });
  return prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId: s.product.id,
      variantId: s.variant.id,
      sellerId: s.sellerId,
      title: s.product.title,
      size: 'M',
      color: '',
      pricePaise: PRICE,
      quantity,
      status,
      shippedAt: status === 'CONFIRMED' ? null : new Date(),
      deliveredAt: status === 'DELIVERED' ? (opts.deliveredAt ?? new Date()) : null,
    },
  });
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: never;
    error?: { code: string; message: string };
  };
  return { status: res.status, json };
}

/** Sorted by type in enum (declaration) order, which is how Postgres sorts an enum. */
async function entriesFor(orderItemId: string) {
  return prisma.sellerLedgerEntry.findMany({ where: { orderItemId }, orderBy: { type: 'asc' } });
}

// ---------------------------------------------------------------------------

describe('posting and balances', () => {
  it('sums the bucket, nothing more', async () => {
    const s = await makeSeller();
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);
    await postEntry({ sellerId: s.sellerId, type: 'ADJUSTMENT', bucket: 'SETTLEMENT', amountPaise: 5_000, note: 'a' });
    await postEntry({ sellerId: s.sellerId, type: 'ADJUSTMENT', bucket: 'SETTLEMENT', amountPaise: -1_200, note: 'b' });
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(3_800);
  });

  it('keeps promotion credits out of the settlement balance, and vice versa', async () => {
    const s = await makeSeller();
    await postEntry({ sellerId: s.sellerId, type: 'PROMOTION_CREDIT_PURCHASE', bucket: 'PROMOTION', amountPaise: 50_000 });
    await postEntry({ sellerId: s.sellerId, type: 'ADJUSTMENT', bucket: 'SETTLEMENT', amountPaise: 7_000, note: 'c' });
    expect(await balance(s.sellerId, 'PROMOTION')).toBe(50_000);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(7_000);
  });
});

describe('delivery', () => {
  it('posts the sale and each deduction from the shared calculator', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 'SHIPPED');
    const { status } = await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    expect(status).toBe(200);

    const rows = await entriesFor(line.id);
    expect(rows.map((r) => [r.type, r.amountPaise, r.bucket])).toEqual([
      ['SALE_EARNING', PRICE, 'SETTLEMENT'],
      ['COMMISSION', -COMMISSION, 'SETTLEMENT'],
      ['PLATFORM_FEE', -PLATFORM, 'SETTLEMENT'],
      ['GATEWAY_FEE', -GATEWAY, 'SETTLEMENT'],
      ['TDS', -TDS, 'SETTLEMENT'],
      ['DELIVERY_FEE', -DELIVERY, 'SETTLEMENT'],
      ['CLOSING_FEE', -CLOSING, 'SETTLEMENT'],
      ['GST_TCS', -TCS, 'SETTLEMENT'],
      ['GT_CHARGE', -GT, 'SETTLEMENT'],
    ]);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(NET);
  });

  it('posts exactly one set however many times the delivery is replayed', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 'SHIPPED');
    await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });

    // A second "deliver" is refused by the status machine…
    const again = await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    expect(again.status).toBe(400);
    // …and a direct replay of the poster, which has no such guard, is a no-op
    // because the (orderItemId, type) pair already exists.
    expect(await postDeliveryEntries(line.id)).toBe(0);
    expect(await postDeliveryEntries(line.id)).toBe(0);

    expect(await entriesFor(line.id)).toHaveLength(ENTRIES_PER_DELIVERY);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(NET);
  });

  it('uses the line total, with closing per unit and the other fixed fees per line', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 'SHIPPED', { quantity: 3 });
    await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    const rows = await entriesFor(line.id);
    const of = (type: string) => rows.find((r) => r.type === type)?.amountPaise;
    expect(of('SALE_EARNING')).toBe(PRICE * 3);
    expect(of('CLOSING_FEE')).toBe(-CLOSING * 3);
    expect(of('GT_CHARGE')).toBe(-GT * 3);
    expect(of('PLATFORM_FEE')).toBe(-PLATFORM);
    expect(of('DELIVERY_FEE')).toBe(-DELIVERY);
  });

  it('posts the GT charge per unit at the setting, and the payouts page states it', async () => {
    await setSetting('gtChargePaise', 4_500);
    try {
      const s = await makeSeller();
      const line = await makeLine(s, 'SHIPPED', { quantity: 2 });
      await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
      const rows = await entriesFor(line.id);
      expect(rows.find((r) => r.type === 'GT_CHARGE')?.amountPaise).toBe(-9_000);
      const overview = await call('GET', '/api/seller/payouts/overview', s.token);
      expect((overview.json.data as { rates: { gtChargePaise: number } }).rates.gtChargePaise).toBe(4_500);
    } finally {
      await setSetting('gtChargePaise', DEFAULT_SETTINGS.gtChargePaise);
    }
  });

  it('follows the fixed-fee settings, not compiled-in numbers', async () => {
    await setSetting('platformFeePaise', 1_500);
    await setSetting('deliveryFeePaise', 0);
    const s = await makeSeller();
    const line = await makeLine(s, 'SHIPPED');
    await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    const rows = await entriesFor(line.id);
    expect(rows.find((r) => r.type === 'PLATFORM_FEE')?.amountPaise).toBe(-1_500);
    // A fee set to zero posts no row — an empty line explains nothing.
    expect(rows.find((r) => r.type === 'DELIVERY_FEE')).toBeUndefined();
  });

  it('follows the commission setting, not a compiled-in rate', async () => {
    await setSetting('payoutCommissionPercent', 25);
    const s = await makeSeller();
    const line = await makeLine(s, 'SHIPPED');
    await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    const commission = (await entriesFor(line.id)).find((r) => r.type === 'COMMISSION');
    // 25% of the ₹2,542.37 seller price, not of the ₹3,000 the buyer paid.
    expect(commission?.amountPaise).toBe(-63_559);
  });
});

describe('returns', () => {
  it('reverses the delivery in one entry, once', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 'SHIPPED');
    await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(NET);

    expect(await postReturnReversal(line.id)).toBe(true);
    expect(await postReturnReversal(line.id)).toBe(false);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);
    expect(await entriesFor(line.id)).toHaveLength(ENTRIES_PER_DELIVERY + 1);
  });

  it('has nothing to reverse for a line delivered before the ledger existed', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 'DELIVERED');
    expect(await postReturnReversal(line.id)).toBe(false);
    expect(await entriesFor(line.id)).toHaveLength(0);
  });
});

describe('payouts', () => {
  it('shows the ledger as what is available, and pays exactly that', async () => {
    await setSetting('payoutHoldDays', 0);
    const s = await makeSeller();
    const line = await makeLine(s, 'SHIPPED');
    await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    // Delivered a moment ago; a zero-day hold clears it at once.
    await prisma.orderItem.update({ where: { id: line.id }, data: { deliveredAt: new Date(Date.now() - 60_000) } });

    const overview = await call('GET', '/api/seller/payouts/overview', s.token);
    expect(overview.status).toBe(200);
    expect((overview.json.data as { kpis: { payablePaise: number } }).kpis.payablePaise).toBe(NET);

    const method = await call('POST', '/api/seller/payouts/methods', s.token, {
      type: 'UPI',
      label: 'Main UPI',
      accountName: 'Ledger Seller',
      upiId: 'ledger@upi',
    });
    expect(method.status).toBe(200);
    await verifiedPan(s.sellerId);

    const payout = await call('POST', '/api/seller/payouts/request', s.token, {});
    expect(payout.status).toBe(200);
    const row = payout.json.data as { id: string; netPaise: number; grossPaise: number; status: string };
    expect(row.netPaise).toBe(NET);
    expect(row.grossPaise).toBe(PRICE);
    expect(row.status).toBe('PAID');

    const entries = await prisma.sellerLedgerEntry.findMany({ where: { payoutId: row.id } });
    expect(entries.map((e) => [e.type, e.amountPaise])).toEqual([['PAYOUT', -NET]]);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);
  });

  it('itemises a payout with the category GST rule the ledger used', async () => {
    // A ₹2,625 shirt is ₹2,500 ex-GST at 5%; read at the standard 18% it would
    // be ₹2,224.58, and TDS/TCS on that would not match what was posted.
    await setSetting('payoutHoldDays', 0);
    const slab = await prisma.category.create({
      data: { name: 'Ledger Apparel', slug: `ledger-apparel-${seq}`, taxRule: 'VALUE_SLAB' },
    });
    invalidateCategoryRules();
    const s = await makeSeller();
    await prisma.product.update({ where: { id: s.product.id }, data: { categoryId: slab.id } });
    const line = await makeLine(s, 'SHIPPED');
    await prisma.orderItem.update({ where: { id: line.id }, data: { pricePaise: 262_500 } });
    await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    await prisma.orderItem.update({ where: { id: line.id }, data: { deliveredAt: new Date(Date.now() - 60_000) } });
    const tds = await prisma.sellerLedgerEntry.findFirstOrThrow({ where: { orderItemId: line.id, type: 'TDS' } });
    expect(tds.amountPaise).toBe(-250);

    await call('POST', '/api/seller/payouts/methods', s.token, {
      type: 'UPI',
      label: 'Main UPI',
      accountName: 'Ledger Seller',
      upiId: 'slab@upi',
    });
    await verifiedPan(s.sellerId);
    const payout = await call('POST', '/api/seller/payouts/request', s.token, {});
    const row = payout.json.data as { id: string; netPaise: number };
    const detail = await call('GET', `/api/seller/payouts/${row.id}`, s.token);
    const lines = (detail.json.data as { lines: { tdsPaise: number; netPaise: number }[] }).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].tdsPaise).toBe(250);
    expect(lines[0].netPaise).toBe(row.netPaise);
  });

  it('picks up lines delivered before the ledger existed, at today\'s rates', async () => {
    await setSetting('payoutHoldDays', 0);
    const s = await makeSeller();
    const line = await makeLine(s, 'DELIVERED', { deliveredAt: new Date(Date.now() - 86_400_000) });
    expect(await entriesFor(line.id)).toHaveLength(0);

    const overview = await call('GET', '/api/seller/payouts/overview', s.token);
    expect((overview.json.data as { kpis: { payablePaise: number } }).kpis.payablePaise).toBe(NET);
    expect(await entriesFor(line.id)).toHaveLength(ENTRIES_PER_DELIVERY);
  });

  it('holds delivery entries back until the line clears, but not penalties', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 'SHIPPED');
    await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    await postEntry({ sellerId: s.sellerId, type: 'ADJUSTMENT', bucket: 'SETTLEMENT', amountPaise: -2_500, note: 'd' });

    const overview = await call('GET', '/api/seller/payouts/overview', s.token);
    const kpis = (overview.json.data as { kpis: { payablePaise: number; inClearingPaise: number } }).kpis;
    // The sale is inside the 7-day hold; the adjustment counts at once and
    // alone it is negative, so nothing is payable yet.
    expect(kpis.inClearingPaise).toBe(NET);
    expect(kpis.payablePaise).toBe(0);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(NET - 2_500);
  });
});

describe('GET /api/seller/ledger', () => {
  it('lists newest first with a running balance, per bucket', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 'SHIPPED');
    await call('PATCH', `/api/seller/orders/${line.id}/status`, s.token, { action: 'deliver' });
    await postEntry({ sellerId: s.sellerId, type: 'PROMOTION_CREDIT_PURCHASE', bucket: 'PROMOTION', amountPaise: 10_000 });

    const settlement = await call('GET', '/api/seller/ledger?bucket=SETTLEMENT', s.token);
    expect(settlement.status).toBe(200);
    const page = settlement.json.data as {
      balancePaise: number;
      total: number;
      rows: { type: string; amountPaise: number; runningBalancePaise: number; reference: { orderNumber: string | null } }[];
    };
    expect(page.total).toBe(ENTRIES_PER_DELIVERY);
    expect(page.balancePaise).toBe(NET);
    expect(page.rows[0].runningBalancePaise).toBe(NET);
    // Oldest row (last on the page) started the running balance.
    const oldest = page.rows[page.rows.length - 1];
    expect(oldest.runningBalancePaise).toBe(oldest.amountPaise);
    expect(page.rows.every((r) => r.reference.orderNumber?.startsWith('CLW-LDG-'))).toBe(true);

    const promotion = await call('GET', '/api/seller/ledger?bucket=PROMOTION', s.token);
    const promo = promotion.json.data as { balancePaise: number; total: number };
    expect(promo.total).toBe(1);
    expect(promo.balancePaise).toBe(10_000);
  });

  it('is a seller-only route', async () => {
    const s = await makeSeller();
    const shopperToken = signAccessToken({ sub: s.shopperId, role: 'CUSTOMER' });
    const { status } = await call('GET', '/api/seller/ledger', shopperToken);
    expect(status).toBe(403);
  });
});
