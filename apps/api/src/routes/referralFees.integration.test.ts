import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeListingEconomics, type PricingRatesView, type SellerFeesV2 } from '@clowe/shared';
import { createApp } from '../app';
import { postDeliveryEntries } from '../services/sellerLedgerService';
import { activeReferralSchedule, invalidateReferralFees } from '../services/referralFees';
import { applyCategoryMapping, createScheduleVersion } from '../services/referralFees/apply';
import { parseFeeSheet, scheduleRates } from '../services/referralFees/sheet';
import type { SheetRow } from '../services/referralFees/xlsx';
import { economicsRates } from '../services/economicsRates';
import { getSettings } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';
import { TEST_SELLER_ADDRESS } from '../test/fixture';

/**
 * The referral fee schedule at checkout: the rate of the category's slab for
 * the line's unit price (GST included), on the whole price; gaps from the
 * family's "Other products" row; a category with no schedule category on its
 * flat rate; a child as its parent; a new version only for orders placed
 * after it takes effect — earlier lines keep theirs — and the ledger on
 * delivery to the paisa.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let buyerToken: string;
let sellerToken: string;
let addressId: string;
let sellerId: string;
const cat: Record<string, string> = {};
const variant: Record<string, string> = {};

// The sheet's own layout: a title, notes, the header, a group heading, rows.
const SHEET_ROWS: SheetRow[] = [
  { A: 'CLOWE - Seller Referral Fee Schedule' },
  { A: 'Group', B: 'Category', C: 'Item Price Slab (INR)', D: 'Benchmark Rate', E: 'CLOWE Rate', F: 'Saving vs Benchmark' },
  { A: 'SOFTLINE' },
  { A: 'Softline', B: 'Apparel - Shirts', C: '> 1,000', D: '0.215', E: '0.19' },
  { A: 'Softline', B: 'Apparel - Other products', C: '<= 1,000', D: '0.025', E: '0' },
  { A: 'Softline', B: 'Apparel - Other products', C: '> 1,000', D: '0.195', E: '0.17' },
  { A: 'MEDIA' },
  { A: 'Media', B: 'Books', C: '<= 250', D: '0', E: '0' },
  { A: 'Media', B: 'Books', C: '> 250 and <= 500', D: '0.02', E: '0.01' },
  { A: 'Media', B: 'Books', C: '> 500 and <= 1,000', D: '0.045', E: '0.02' },
  { A: 'Media', B: 'Books', C: '> 1,000', D: '0.145', E: '0.12' },
];

async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

/** A paid order for one unit of a variant; its line. */
async function boughtLine(key: string) {
  expect((await call('POST', '/api/cart/items', buyerToken, { variantId: variant[key], quantity: 1 })).status).toBe(200);
  const co = await call<{ orderId: string }>('POST', '/api/orders/checkout', buyerToken, { addressId, paymentMethod: 'UPI' });
  expect(co.status, JSON.stringify(co.json)).toBe(200);
  expect((await call('POST', '/api/payments/mock-pay', buyerToken, { orderId: co.json.data.orderId, outcome: 'success' })).status).toBe(200);
  return prisma.orderItem.findFirstOrThrow({ where: { orderId: co.json.data.orderId } });
}

async function product(key: string, categoryId: string, pricePaise: number) {
  const p = await prisma.product.create({
    data: { sellerId, categoryId, title: `RF ${key}`, slug: `rf-${key}`, description: 'For the referral fee tests.', basePricePaise: pricePaise, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  variant[key] = (await prisma.productVariant.create({ data: { productId: p.id, optionValues: {}, optionsKey: '', label: '', sku: `SKU-RF-${key}`, pricePaise, stock: 50 } })).id;
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { phone: '9177300000', name: 'RF Admin', role: Role.ADMIN, referralCode: 'RF-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const sellerUser = await prisma.user.create({ data: { phone: '9177300001', name: 'RF Seller', role: Role.SELLER, referralCode: 'RF-S' } });
  sellerToken = signAccessToken({ sub: sellerUser.id, role: 'SELLER' });
  sellerId = (
    await prisma.sellerProfile.create({
      data: { ...TEST_SELLER_ADDRESS, userId: sellerUser.id, shopName: 'RF Shop', slug: 'rf-shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5' },
    })
  ).id;
  const buyer = await prisma.user.create({ data: { phone: '9177300002', name: 'RF Buyer', referralCode: 'RF-B' } });
  buyerToken = signAccessToken({ sub: buyer.id, role: 'CUSTOMER' });
  addressId = (
    await prisma.address.create({ data: { userId: buyer.id, name: 'RF Buyer', phone: buyer.phone, line1: '1 Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true } })
  ).id;
  cat.shirts = (await prisma.category.create({ data: { name: 'RF Shirts', slug: 'rf-shirts', isActive: true, defaultTaxRatePercent: 5, referralPercent: 2 } })).id;
  cat.books = (await prisma.category.create({ data: { name: 'RF Books', slug: 'rf-books', isActive: true, defaultTaxRatePercent: 5, referralPercent: 2 } })).id;
  cat.novels = (await prisma.category.create({ data: { name: 'RF Novels', slug: 'rf-novels', parentId: cat.books, isActive: true, defaultTaxRatePercent: 5, referralPercent: 3 } })).id;
  cat.flat = (await prisma.category.create({ data: { name: 'RF Flat', slug: 'rf-flat', isActive: true, defaultTaxRatePercent: 5, referralPercent: 4 } })).id;
  await product('shirt-1500', cat.shirts, 150_000);
  await product('shirt-1000', cat.shirts, 100_000);
  await product('shirt-1000-01', cat.shirts, 100_001);
  await product('novel-500', cat.novels, 50_000);
  await product('flat-1500', cat.flat, 150_000);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the referral fee schedule at checkout', () => {
  let firstVersion: number;
  let shirtLineV1: string;

  it('before any schedule, every category keeps its flat rate', async () => {
    // Other test files may have stored versions: start from what is in force.
    invalidateReferralFees();
    const line = await boughtLine('flat-1500');
    expect((line.feeRates as unknown as SellerFeesV2).referralPercent).toBe(4);
  });

  it('imports the sheet: every row, the gap filled from "Apparel - Other products"', async () => {
    const { categories, problems } = parseFeeSheet(SHEET_ROWS);
    expect(problems).toEqual([]);
    expect(categories.map((c) => c.sheetCategory)).toEqual(['Apparel - Shirts', 'Apparel - Other products', 'Books']);
    const { rates, gaps } = scheduleRates(categories);
    expect(rates).toHaveLength(7 + 1); // the sheet's 7 rows and the filled gap
    expect(gaps).toEqual([{ group: 'Softline', sheetCategory: 'Apparel - Shirts', range: 'up to ₹1,000', borrowedFrom: 'Apparel - Other products', chosen: false }]);
    const created = await createScheduleVersion({ rates, source: 'test.xlsx', effectiveFrom: new Date(Date.now() - 1_000) });
    firstVersion = created.version;
    await applyCategoryMapping([
      { categoryId: cat.shirts!, sheetCategory: 'Apparel - Shirts' },
      { categoryId: cat.books!, sheetCategory: 'Books' },
    ]);
    expect((await activeReferralSchedule())?.version).toBe(firstVersion);
  });

  it('the sheet’s example: a ₹1,500 shirt pays 19% of ₹1,500, fixed on the line with where it came from', async () => {
    const line = await boughtLine('shirt-1500');
    shirtLineV1 = line.id;
    expect(line.feeRates as unknown as SellerFeesV2).toMatchObject({
      referralPercent: 19,
      referralSource: { scheduleVersion: firstVersion, sheetCategory: 'Apparel - Shirts', slabLabel: '> 1,000', rateBps: 1_900, borrowedFrom: null },
      gtPercent: 1.5,
      collectionPercent: 2,
      gstPercent: 18,
    });
  });

  it('slab edges: exactly ₹1,000 is the ≤ ₹1,000 slab (borrowed 0%), ₹1,000.01 is 19%', async () => {
    const at1000 = await boughtLine('shirt-1000');
    expect(at1000.feeRates as unknown as SellerFeesV2).toMatchObject({ referralPercent: 0, referralSource: { slabLabel: '<= 1,000', borrowedFrom: 'Apparel - Other products' } });
    const above = await boughtLine('shirt-1000-01');
    expect((above.feeRates as unknown as SellerFeesV2).referralPercent).toBe(19);
  });

  it('a subcategory with none of its own is charged as its parent; an unmapped category keeps its flat rate', async () => {
    const novel = await boughtLine('novel-500'); // Books, > ₹250 and <= ₹500: 1%
    expect(novel.feeRates as unknown as SellerFeesV2).toMatchObject({ referralPercent: 1, referralSource: { sheetCategory: 'Books', slabLabel: '> 250 and <= 500' } });
    expect(((await boughtLine('flat-1500')).feeRates as unknown as SellerFeesV2).referralPercent).toBe(4);
  });

  it('on delivery the ledger posts the full breakdown, and the seller’s net, to the paisa', async () => {
    await prisma.orderItem.update({ where: { id: shirtLineV1 }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await postDeliveryEntries(shirtLineV1);
    const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: shirtLineV1 } });
    const rows = await prisma.sellerLedgerEntry.findMany({ where: { orderItemId: shirtLineV1 } });
    const e = Object.fromEntries(rows.map((r) => [r.type, r.amountPaise]));
    expect(e.SALE_EARNING).toBe(150_000);
    expect(e.COMMISSION).toBe(-28_500); // 19% of ₹1,500
    expect(e.GT_CHARGE).toBe(-2_250); // 1.5%
    expect(e.GATEWAY_FEE).toBe(-3_000); // 2%
    expect(e.HANDLING_FEE).toBe(-1_900); // ₹1,000–4,999 slab
    expect(e.CLOWE_FEE_GST).toBe(-6_417); // 18% of ₹356.50
    // TDS and TCS on the price before GST, at the line's own GST rate.
    const expected = computeListingEconomics({
      buyerPricePaise: 150_000,
      gstRatePercent: line.gstRatePercent,
      rates: { ...economicsRates(await getSettings()), v2: line.feeRates as unknown as SellerFeesV2 },
    });
    expect(e.TDS).toBe(-expected.tdsPaise);
    expect(e.GST_TCS).toBe(-expected.tcsPaise);
    const net = rows.reduce((sum, r) => sum + r.amountPaise, 0);
    expect(net).toBe(expected.sellerReceivesPaise);
    expect(net).toBe(150_000 - 28_500 - 2_250 - 3_000 - 1_900 - 6_417 - expected.tdsPaise - expected.tcsPaise);
  });

  it('the listing form gets the slabs; the public page gets the schedule', async () => {
    const rates = (await call<PricingRatesView>('GET', '/api/seller/pricing-rates', sellerToken)).json.data;
    expect(rates.categoryReferralSlabs?.[cat.novels!]).toMatchObject({ sheetCategory: 'Books', scheduleVersion: firstVersion });
    expect(rates.categoryReferralSlabs?.[cat.flat!]).toBeUndefined();
    const table = (await call<{ version: number; groups: { group: string }[] }>('GET', '/api/referral-fees', null)).json.data;
    expect(table.version).toBeGreaterThanOrEqual(firstVersion);
  });

  it('an admin change is a new version for orders placed from then; lines placed before keep their rate', async () => {
    const bad = await call('POST', '/api/admin/referral-fees/versions', adminToken, {
      baseVersion: firstVersion,
      sheetCategory: 'Apparel - Shirts',
      slabs: [{ label: '> 1,000', ratePercent: 15 }],
      note: 'leaves ₹0–1,000 uncovered',
    });
    expect(bad.status).toBe(400);
    expect((await call('POST', '/api/admin/referral-fees/versions', buyerToken, {})).status).toBe(403);

    const edit = await call<{ version: number }>('POST', '/api/admin/referral-fees/versions', adminToken, {
      baseVersion: firstVersion,
      sheetCategory: 'Apparel - Shirts',
      slabs: [
        { label: '<= 1,000', ratePercent: 0 },
        { label: '> 1,000', ratePercent: 15.5 },
      ],
      note: 'Owner lowered the shirt rate',
    });
    expect(edit.status, JSON.stringify(edit.json)).toBe(201);
    expect(edit.json.data.version).toBe(firstVersion + 1);
    // Everything else carried over.
    expect(await prisma.referralFeeRate.count({ where: { schedule: { version: firstVersion + 1 } } })).toBe(
      (await prisma.referralFeeRate.count({ where: { schedule: { version: firstVersion } } })) - 2 + 2,
    );

    const after = await boughtLine('shirt-1500');
    expect(after.feeRates as unknown as SellerFeesV2).toMatchObject({ referralPercent: 15.5, referralSource: { scheduleVersion: firstVersion + 1 } });
    const before = await prisma.orderItem.findUniqueOrThrow({ where: { id: shirtLineV1 } });
    expect((before.feeRates as unknown as SellerFeesV2).referralPercent).toBe(19);
  });

  it('a version that takes effect later changes nothing until then', async () => {
    const current = (await activeReferralSchedule())!.version;
    const rates = scheduleRates(parseFeeSheet(SHEET_ROWS).categories).rates.map((r) => (r.sheetCategory === 'Apparel - Shirts' && r.slabLabel === '> 1,000' ? { ...r, rateBps: 500 } : r));
    const later = await createScheduleVersion({ rates, source: 'later.xlsx', effectiveFrom: new Date(Date.now() + 3_600_000) });
    expect((await activeReferralSchedule())?.version).toBe(current);
    expect(((await boughtLine('shirt-1500')).feeRates as unknown as SellerFeesV2).referralPercent).toBe(15.5);
    expect((await activeReferralSchedule(new Date(Date.now() + 2 * 3_600_000)))?.version).toBe(later.version);
    // Withdrawn, so no other test sees it take effect.
    await prisma.referralFeeSchedule.delete({ where: { id: later.id } });
    invalidateReferralFees();
  });

  it('the mapping is admin-only and refuses a category the schedule does not have', async () => {
    expect((await call('PUT', `/api/admin/referral-fees/mapping/${cat.flat}`, adminToken, { sheetCategory: 'Not A Row' })).status).toBe(400);
    const ok = await call<{ before: string | null; after: string | null }>('PUT', `/api/admin/referral-fees/mapping/${cat.flat}`, adminToken, { sheetCategory: 'Books' });
    expect(ok.json.data).toEqual({ categoryId: cat.flat, before: null, after: 'Books' });
    expect((await call('PUT', `/api/admin/referral-fees/mapping/${cat.flat}`, sellerToken, { sheetCategory: null })).status).toBe(403);
    await call('PUT', `/api/admin/referral-fees/mapping/${cat.flat}`, adminToken, { sheetCategory: null });
  });
});
