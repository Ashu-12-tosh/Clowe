import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDate, type ReconcileReport } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { postDeliveryEntries, postReturnReversal } from '../services/sellerLedgerService';
import { requestPayout } from '../services/payoutService';
import { gstr8Rows } from '../services/gstr8';

/**
 * GST TCS (s.52) as its own figure: posted with the value it was taken on,
 * its own column on payouts, and the per-supplier monthly totals GSTR-8 is
 * filed from.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let categoryId: string;
let seq = 0;

// ₹3,000 in a category with no GST rule: 18%, so ₹2,542.37 ex-GST, TCS 0.5% = ₹12.71.
const PRICE = 300_000;
const EX_GST = 254_237;
const TCS = 1_271;

beforeAll(async () => {
  await seedFixture(prisma);
  categoryId = (await prisma.category.findFirstOrThrow({ where: { isActive: true } })).id;
  const admin = await prisma.user.create({ data: { phone: '9140000000', name: 'TCS Admin', role: Role.ADMIN, referralCode: 'TCS-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function seller(opts: { gstNumber?: string | null; state?: string | null } = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `91400${String(seq).padStart(5, '0')}`, name: `TCS Seller ${seq}`, role: Role.SELLER, referralCode: `TCS-S-${seq}` },
  });
  const profile = await prisma.sellerProfile.create({
    data: {
      userId: user.id,
      shopName: `TCS Shop ${seq}`,
      status: SellerStatus.APPROVED,
      approvedAt: new Date(),
      gstNumber: opts.gstNumber === undefined ? `27ABCDE${String(seq).padStart(4, '0')}F1Z5` : opts.gstNumber,
      state: opts.state === undefined ? 'Maharashtra' : opts.state,
    },
  });
  const product = await prisma.product.create({
    data: { sellerId: profile.id, categoryId, title: `TCS ${seq}`, slug: `tcs-${seq}`, description: 'GST TCS test listing.', basePricePaise: PRICE, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: `TCS-SKU-${seq}`, pricePaise: PRICE, stock: 50 },
  });
  const shopper = await prisma.user.create({ data: { phone: `91500${String(seq).padStart(5, '0')}`, name: 'TCS Shopper', referralCode: `TCS-U-${seq}` } });
  return { userId: user.id, sellerId: profile.id, product, variant, shopperId: shopper.id };
}

/** A delivered line shipped to `shipState`, with its ledger entries posted. */
async function delivered(s: Awaited<ReturnType<typeof seller>>, shipState: string, deliveredAt = new Date()) {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: `CLW-TCS-${seq}`, userId: s.shopperId, shipName: 'S', shipPhone: '9150000000', shipLine1: '1 Lane',
      shipCity: 'City', shipState, shipPincode: '400001', status: 'DELIVERED', subtotalPaise: PRICE, totalPaise: PRICE, paymentMethod: 'UPI',
    },
  });
  const item = await prisma.orderItem.create({
    data: {
      orderId: order.id, productId: s.product.id, variantId: s.variant.id, sellerId: s.sellerId, title: 'tcs',
      size: '', color: '', pricePaise: PRICE, quantity: 1, status: 'DELIVERED', shippedAt: deliveredAt, deliveredAt,
    },
  });
  await postDeliveryEntries(item.id);
  return item;
}

const thisMonth = () => {
  const { year, month } = istDate(new Date());
  return `${year}-${String(month + 1).padStart(2, '0')}`;
};

describe('the TCS ledger entry', () => {
  it('records the taxable value it was taken on', async () => {
    const s = await seller();
    const item = await delivered(s, 'Maharashtra');
    const entry = await prisma.sellerLedgerEntry.findFirstOrThrow({ where: { orderItemId: item.id, type: 'GST_TCS' } });
    expect(entry).toMatchObject({ amountPaise: -TCS, taxablePaise: EX_GST });
  });
});

describe('payouts', () => {
  it('carry TCS in its own column, and still add up', async () => {
    await prisma.platformSetting.upsert({ where: { key: 'payoutHoldDays' }, update: { value: 0 }, create: { key: 'payoutHoldDays', value: 0 } });
    const s = await seller();
    await delivered(s, 'Maharashtra', new Date(Date.now() - 60_000));
    await prisma.sellerPayoutMethod.create({
      data: { sellerId: s.sellerId, type: 'UPI', label: 'UPI', accountName: 'TCS Seller', upiId: 'tcs@upi', isDefault: true, verified: true },
    });
    const payout = await requestPayout(s.sellerId);
    const row = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
    expect(row.tcsPaise).toBe(TCS);
    expect(row.grossPaise - row.commissionPaise - row.gatewayPaise - row.otherFeesPaise - row.tdsPaise - row.tcsPaise - row.adjustmentPaise).toBe(
      row.netPaise,
    );
    await prisma.platformSetting.deleteMany({ where: { key: 'payoutHoldDays' } });
  });

  it('reconcile, including one that recovered ad spend; a wrong one is still flagged', async () => {
    const s = await seller();
    const base_ = { sellerId: s.sellerId, periodFrom: new Date(), periodTo: new Date(), status: 'PAID' as const, grossPaise: 100_000, commissionPaise: 10_000, gatewayPaise: 2_000, otherFeesPaise: 900, tdsPaise: 85, tcsPaise: 424 };
    await prisma.payout.create({ data: { ...base_, reference: 'PAY-TCS-OK', adjustmentPaise: 5_000, netPaise: 100_000 - 10_000 - 2_000 - 900 - 85 - 424 - 5_000 } });
    await prisma.payout.create({ data: { ...base_, reference: 'PAY-TCS-BAD', adjustmentPaise: 0, netPaise: 99_999 } });
    const res = await fetch(`${base}/api/admin/payments/reconcile`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` } });
    const report = ((await res.json()) as { data: ReconcileReport }).data;
    const mismatched = report.findings.filter((f) => f.check === 'PAYOUT_MATH_MISMATCH').map((f) => f.reference);
    expect(mismatched).not.toContain('PAY-TCS-OK');
    expect(mismatched).toContain('PAY-TCS-BAD');
  });

  it('made before this change get their TCS moved out of other fees by the migration', async () => {
    const s = await seller();
    const item = await delivered(s, 'Maharashtra');
    const old = await prisma.payout.create({
      data: {
        sellerId: s.sellerId, reference: 'PAY-TCS-OLD', periodFrom: new Date(), periodTo: new Date(), status: 'PAID',
        grossPaise: PRICE, otherFeesPaise: 8_900 + TCS, tcsPaise: 0, netPaise: 1,
      },
    });
    await prisma.orderItem.update({ where: { id: item.id }, data: { payoutId: old.id } });
    const sql = readFileSync(path.resolve(__dirname, '../../prisma/migrations/20261004130000_payout_tcs/migration.sql'), 'utf8');
    const backfill = sql.slice(sql.indexOf('UPDATE "payouts"'));
    await prisma.$executeRawUnsafe(backfill);
    const after = await prisma.payout.findUniqueOrThrow({ where: { id: old.id } });
    expect(after).toMatchObject({ tcsPaise: TCS, otherFeesPaise: 8_900 });
  });
});

describe('GSTR-8', () => {
  it('totals each supplier by place of supply, nets off returns, and flags a missing GSTIN', async () => {
    const s = await seller({ state: 'Maharashtra' });
    await delivered(s, 'Maharashtra'); // intra-state: CGST + SGST
    await delivered(s, 'Karnataka'); // inter-state: IGST
    const back = await delivered(s, 'Maharashtra');
    await prisma.orderItem.update({ where: { id: back.id }, data: { status: 'RETURNED' } });
    await postReturnReversal(back.id);
    const noGstin = await seller({ gstNumber: null, state: null });
    await delivered(noGstin, 'Maharashtra');

    const rows = await gstr8Rows(thisMonth());
    const mine = rows.find((r) => r.sellerId === s.sellerId)!;
    expect(mine).toMatchObject({
      suppliesTaxablePaise: 3 * EX_GST,
      returnsTaxablePaise: EX_GST,
      netTaxablePaise: 2 * EX_GST,
      igstPaise: TCS,
      // Two intra-state supplies less one return: one TCS, split in halves.
      cgstPaise: Math.trunc(TCS / 2),
      sgstPaise: TCS - Math.trunc(TCS / 2),
    });
    const flagged = rows.find((r) => r.sellerId === noGstin.sellerId)!;
    expect(flagged.gstin).toBeNull();
    expect(flagged.notes).toEqual(['No GSTIN on file', 'No seller state on file: treated as inter-state']);
    expect(flagged.igstPaise).toBe(TCS);
  });

  it('downloads as a CSV for admins', async () => {
    const res = await fetch(`${base}/api/admin/payments/gstr8?month=${thisMonth()}`, { headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.split('\n')[0]).toContain('GSTIN of supplier');
    expect(csv).toContain('TOTAL');
    expect((await fetch(`${base}/api/admin/payments/gstr8?month=2026-13`, { headers: { authorization: `Bearer ${adminToken}` } })).status).toBe(400);
  });
});
