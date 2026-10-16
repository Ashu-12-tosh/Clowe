import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SellerFeesV2 } from '@clowe/shared';
import { createApp } from '../app';
import { postDeliveryEntries } from '../services/sellerLedgerService';
import { signAccessToken } from '../utils/jwt';

/**
 * The owner's Batch 2 fees on an order line: fixed at checkout (new orders
 * only — older lines keep theirs), posted on delivery as referral, GT,
 * collection and handling fees plus GST on them; no handling fee for a VIP
 * seller; admin penalties with a reason, audit-logged, waivable; the rules
 * themselves validated whole.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let buyerToken: string;
let addressId: string;
let sellerId: string;
let sellerUserId: string;
let variantId: string;
let productId: string;

async function call<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

/** A paid order for one ₹1,000 unit (GST 18% inside), delivered. */
async function deliveredLine() {
  expect((await call('POST', '/api/cart/items', buyerToken, { variantId, quantity: 1 })).status).toBe(200);
  const co = await call<{ orderId: string }>('POST', '/api/orders/checkout', buyerToken, { addressId, paymentMethod: 'UPI' });
  expect(co.status, JSON.stringify(co.json)).toBe(200);
  expect((await call('POST', '/api/payments/mock-pay', buyerToken, { orderId: co.json.data.orderId, outcome: 'success' })).status).toBe(200);
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: co.json.data.orderId } });
  await prisma.orderItem.update({ where: { id: item.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
  return item;
}

const entries = (orderItemId: string) =>
  prisma.sellerLedgerEntry.findMany({ where: { orderItemId }, orderBy: { createdAt: 'asc' } }).then((rows) => Object.fromEntries(rows.map((r) => [r.type, r])));

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { phone: '9177200000', name: 'Fees Admin', role: Role.ADMIN, referralCode: 'FEE-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const sellerUser = await prisma.user.create({ data: { phone: '9177200001', name: 'Fees Seller', role: Role.SELLER, referralCode: 'FEE-S' } });
  sellerUserId = sellerUser.id;
  sellerId = (
    await prisma.sellerProfile.create({
      data: { userId: sellerUser.id, shopName: 'Fees Shop', slug: 'fees-shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5' },
    })
  ).id;
  const buyer = await prisma.user.create({ data: { phone: '9177200002', name: 'Fees Buyer', referralCode: 'FEE-B' } });
  buyerToken = signAccessToken({ sub: buyer.id, role: 'CUSTOMER' });
  addressId = (
    await prisma.address.create({ data: { userId: buyer.id, name: 'Fees Buyer', phone: buyer.phone, line1: '1 Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true } })
  ).id;
  const category = await prisma.category.create({ data: { name: 'Fee Gadgets', slug: 'fee-gadgets', isActive: true, defaultTaxRatePercent: 18 } });
  productId = (
    await prisma.product.create({
      data: { sellerId, categoryId: category.id, title: 'Fee Gadget', slug: 'fee-gadget', description: 'For the fee tests.', basePricePaise: 100_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-FEE', pricePaise: 100_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('fees on a new order line', () => {
  it('are fixed at checkout and posted on delivery: the ₹1,000 example', async () => {
    const item = await deliveredLine();
    expect(item.feeModel).toBe(2);
    expect(item.feeRates as unknown as SellerFeesV2).toMatchObject({ referralPercent: 2, gtPercent: 1.5, collectionPercent: 2, handlingWaived: false, gstPercent: 18 });
    await postDeliveryEntries(item.id);
    const e = await entries(item.id);
    expect(e.SALE_EARNING?.amountPaise).toBe(100_000);
    expect(e.COMMISSION?.amountPaise).toBe(-2_000);
    expect(e.GT_CHARGE?.amountPaise).toBe(-1_500);
    expect(e.GATEWAY_FEE?.amountPaise).toBe(-2_000);
    expect(e.HANDLING_FEE?.amountPaise).toBe(-1_900);
    expect(e.CLOWE_FEE_GST).toMatchObject({ amountPaise: -1_332, taxablePaise: 7_400, chargeType: 'ORDER_FEES' });
    expect(e.TDS?.amountPaise).toBe(-85);
    expect(e.GST_TCS?.amountPaise).toBe(-424);
    expect(e.PLATFORM_FEE).toBeUndefined();
    expect(e.CLOSING_FEE).toBeUndefined();
  });

  it('use the category’s referral fee and keep it after the category changes', async () => {
    await prisma.category.update({ where: { slug: 'fee-gadgets' }, data: { referralPercent: 3 } });
    try {
      const item = await deliveredLine();
      expect((item.feeRates as unknown as SellerFeesV2).referralPercent).toBe(3);
      await prisma.category.update({ where: { slug: 'fee-gadgets' }, data: { referralPercent: 2 } });
      await postDeliveryEntries(item.id);
      expect((await entries(item.id)).COMMISSION?.amountPaise).toBe(-3_000);
    } finally {
      await prisma.category.update({ where: { slug: 'fee-gadgets' }, data: { referralPercent: 2 } });
    }
  });

  it('carry no handling fee for a VIP seller', async () => {
    expect((await call('PATCH', `/api/admin/sellers/${sellerId}/vip`, adminToken, { vip: true })).status).toBe(200);
    try {
      const item = await deliveredLine();
      expect((item.feeRates as unknown as SellerFeesV2).handlingWaived).toBe(true);
      await postDeliveryEntries(item.id);
      const e = await entries(item.id);
      expect(e.HANDLING_FEE).toBeUndefined();
      expect(e.CLOWE_FEE_GST?.amountPaise).toBe(-990);
    } finally {
      await call('PATCH', `/api/admin/sellers/${sellerId}/vip`, adminToken, { vip: false });
    }
  });

  it('leave a line from before Batch 2 on its old fees', async () => {
    const item = await deliveredLine();
    await prisma.orderItem.update({ where: { id: item.id }, data: { feeModel: 1, feeRates: undefined } });
    await postDeliveryEntries(item.id);
    const e = await entries(item.id);
    expect(e.COMMISSION?.amountPaise).toBe(-8_475); // 10% of the price before GST
    expect(e.PLATFORM_FEE?.amountPaise).toBe(-900);
    expect(e.HANDLING_FEE).toBeUndefined();
    expect(e.CLOWE_FEE_GST).toBeUndefined();
  });

  it('come back off the ledger with the line when it is returned', async () => {
    const item = await deliveredLine();
    await postDeliveryEntries(item.id);
    const { postReturnReversal } = await import('../services/sellerLedgerService');
    await prisma.orderItem.update({ where: { id: item.id }, data: { status: 'RETURNED' } });
    expect(await postReturnReversal(item.id)).toBe(true);
    const sum = await prisma.sellerLedgerEntry.aggregate({ where: { orderItemId: item.id }, _sum: { amountPaise: true } });
    expect(sum._sum.amountPaise).toBe(0);
  });
});

describe('admin penalties', () => {
  it('₹150 for a counterfeit listing and ₹1,000 for inaccurate try-on data, with a reason, logged, deducted, waivable', async () => {
    const one = await call<{ entryId: string; amountPaise: number }>('POST', `/api/admin/sellers/${sellerId}/penalties`, adminToken, {
      kind: 'COUNTERFEIT_LISTING',
      reason: 'Listing used another brand’s logo',
    });
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect(one.json.data.amountPaise).toBe(15_000);
    const two = await call<{ entryId: string; amountPaise: number }>('POST', `/api/admin/sellers/${sellerId}/penalties`, adminToken, {
      kind: 'INACCURATE_TRYON_DATA',
      reason: 'Try-on images showed a different garment',
    });
    expect(two.json.data.amountPaise).toBe(100_000);
    expect((await call('POST', `/api/admin/sellers/${sellerId}/penalties`, adminToken, { kind: 'COUNTERFEIT_LISTING', reason: '' })).status).toBe(400);

    const entry = await prisma.sellerLedgerEntry.findUniqueOrThrow({ where: { id: one.json.data.entryId } });
    expect(entry).toMatchObject({ type: 'ADMIN_PENALTY', bucket: 'SETTLEMENT', amountPaise: -15_000 });
    expect(entry.note).toContain('another brand');
    expect(await prisma.notification.count({ where: { userId: sellerUserId, type: 'SELLER_PENALTY' } })).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.auditLog.count({ where: { action: 'Penalty applied', entityId: entry.id } })).toBe(1);

    const sellerToken = signAccessToken({ sub: sellerUserId, role: 'SELLER' });
    const view = await call<{ rows: { entryId: string; kind: string; waived: boolean; amountPaise: number }[] }>('GET', '/api/seller/ledger/penalties', sellerToken);
    expect(view.json.data.rows.find((r) => r.entryId === entry.id)).toMatchObject({ kind: 'ADMIN', amountPaise: 15_000, waived: false });

    const waive = await call('POST', `/api/admin/sellers/${sellerId}/ledger/${entry.id}/waive`, adminToken, { reason: 'Listing fixed the same day' });
    expect(waive.status, JSON.stringify(waive.json)).toBe(200);
    expect((await call('POST', `/api/admin/sellers/${sellerId}/ledger/${entry.id}/waive`, adminToken, { reason: 'Listing fixed the same day' })).status).toBe(409);
    const after = await call<{ rows: { entryId: string; waived: boolean }[] }>('GET', '/api/seller/ledger/penalties', sellerToken);
    expect(after.json.data.rows.find((r) => r.entryId === entry.id)?.waived).toBe(true);
    expect(after.json.data.rows.find((r) => r.entryId === two.json.data.entryId)?.waived).toBe(false);
  });
});

describe('the commercial rules', () => {
  it('change by a partial patch, validated whole, with placement prices kept inside their ranges', async () => {
    const before = (await call<{ fees: { gtPercent: number } }>('GET', '/api/admin/commercial', adminToken)).json.data;
    expect(before.fees.gtPercent).toBe(1.5);
    const ok = await call<{ fees: { gtPercent: number; referralPercent: number } }>('PATCH', '/api/admin/commercial', adminToken, { fees: { gtPercent: 1.75 } });
    expect(ok.json.data.fees).toMatchObject({ gtPercent: 1.75, referralPercent: 2 });
    expect((await call('PATCH', '/api/admin/commercial', adminToken, { fees: { gstPercent: 'lots' } })).json.error?.code).toBe('COMMERCIAL_INVALID');
    const out = await call('PATCH', '/api/admin/commercial', adminToken, { ads: { placements: { HOMEPAGE_BANNER: { pricePaise: 5_000_000 } } } });
    expect(out.json.error?.code).toBe('PRICE_OUT_OF_RANGE');
    await call('PATCH', '/api/admin/commercial', adminToken, { fees: { gtPercent: 1.5 } });
    // Sellers cannot touch them.
    expect((await call('GET', '/api/admin/commercial', signAccessToken({ sub: sellerUserId, role: 'SELLER' }))).status).toBe(403);
  });
});
