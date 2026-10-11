import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaxInvoice } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * The buyer's tax invoice is the seller's: issued under the seller's legal
 * name, GSTIN and address, naming Clowe Partners LLP as the marketplace, with
 * GST at each line's recorded rate, split CGST + SGST within a state and IGST
 * across states. No seller is approved without a GSTIN, and a seller without
 * one gets no payouts.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let sellerToken: string;
let sellerId: string;
let adminToken: string;
let variantA: string; // ₹1,120
let variantB: string; // ₹2,240
let seq = 0;

interface Body<T> {
  data: T;
  error?: { code: string; message: string };
}
async function call<T = unknown>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Body<T> };
}

async function buyer(state: string) {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91980${String(seq).padStart(5, '0')}`, name: `Invoice Buyer ${seq}`, referralCode: `INV-${seq}` } });
  const address = await prisma.address.create({
    data: { userId: user.id, name: 'Invoice Buyer', phone: user.phone, line1: '7 Market Road', city: state === 'Maharashtra' ? 'Pune' : 'Bengaluru', state, pincode: state === 'Maharashtra' ? '411001' : '560001', isDefault: true },
  });
  return { token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }), addressId: address.id };
}

async function orderOf(b: { token: string; addressId: string }, variants: string[], method: 'COD' | 'UPI' = 'COD') {
  for (const variantId of variants) expect((await call('POST', '/api/cart/items', b.token, { variantId, quantity: 1 })).status).toBe(200);
  const co = await call<{ orderId: string }>('POST', '/api/orders/checkout', b.token, { addressId: b.addressId, paymentMethod: method });
  expect(co.status).toBe(200);
  return co.json.data.orderId;
}

beforeAll(async () => {
  await seedFixture(prisma);
  const seller = await prisma.sellerProfile.update({
    where: { slug: 'fixture-store' },
    data: { gstNumber: '27ABCDE1234F1Z5', panName: 'FIXTURE TRADERS', addressLine1: '1 Seller Lane', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
  });
  sellerId = seller.id;
  sellerToken = signAccessToken({ sub: seller.userId, role: 'SELLER' });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const make = async (slug: string, pricePaise: number) => {
    const p = await prisma.product.create({
      data: { sellerId: seller.id, categoryId: category.id, title: slug, slug, description: 'Invoice test.', basePricePaise: pricePaise, status: ProductStatus.APPROVED, approvedAt: new Date() },
    });
    return (await prisma.productVariant.create({ data: { productId: p.id, optionValues: {}, optionsKey: '', label: '', sku: `SKU-${slug}`, pricePaise, stock: 100 } })).id;
  };
  variantA = await make('invoice-a', 112_000);
  variantB = await make('invoice-b', 224_000);
  const admin = await prisma.user.create({ data: { phone: '9198100000', name: 'Invoice Admin', role: Role.ADMIN, referralCode: 'INV-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe("the buyer's tax invoice", () => {
  it('is issued by the seller under their GSTIN, names the marketplace, and taxes each line at its recorded rate (same state: CGST + SGST)', async () => {
    const b = await buyer('Maharashtra');
    const orderId = await orderOf(b, [variantA]);
    // The rate the line was sold at, whatever the category says today.
    await prisma.orderItem.updateMany({ where: { orderId }, data: { gstRatePercent: 12 } });

    const res = await call<TaxInvoice[]>('GET', `/api/orders/${orderId}/invoices`, b.token);
    expect(res.status).toBe(200);
    expect(res.json.data).toHaveLength(1);
    const inv = res.json.data[0]!;
    expect(inv.seller).toMatchObject({ legalName: 'FIXTURE TRADERS', gstNumber: '27ABCDE1234F1Z5', line1: '1 Seller Lane', state: 'Maharashtra' });
    expect(inv.marketplace.name).toBe('CLOWE PARTNERS LLP');

    const line = inv.lines[0]!;
    expect(line.gstRatePercent).toBe(12);
    expect(line.taxablePaise).toBe(100_000); // ₹1,120 / 1.12
    expect(line.gstPaise).toBe(12_000);
    expect(inv.isIntraState).toBe(true);
    expect(line.cgstPaise + line.sgstPaise).toBe(12_000);
    expect(line.cgstPaise).toBe(6_000);
    expect(line.igstPaise).toBe(0);
    expect(inv).toMatchObject({ cgstPaise: 6_000, sgstPaise: 6_000, igstPaise: 0, totalPaise: 112_000 });
  });

  it('charges IGST across states', async () => {
    const b = await buyer('Karnataka');
    const orderId = await orderOf(b, [variantA]);
    await prisma.orderItem.updateMany({ where: { orderId }, data: { gstRatePercent: 12 } });
    const inv = (await call<TaxInvoice[]>('GET', `/api/orders/${orderId}/invoices`, b.token)).json.data[0]!;
    expect(inv.isIntraState).toBe(false);
    expect(inv).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 12_000 });
  });

  it("is the same document as the seller's copy, number and figures", async () => {
    const b = await buyer('Maharashtra');
    const orderId = await orderOf(b, [variantA, variantB]);
    const mine = (await call<TaxInvoice[]>('GET', `/api/orders/${orderId}/invoices`, b.token)).json.data[0]!;
    const theirs = (await call<TaxInvoice & { qr: unknown }>('GET', `/api/seller/orders/${orderId}/invoice`, sellerToken)).json.data;
    // Issued-at is the moment each was built; the QR is the seller's alone.
    const without = (o: object, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
    expect(without(mine, ['issuedAt'])).toEqual(without(theirs, ['issuedAt', 'qr']));
  });

  it('leaves cancelled lines out', async () => {
    const b = await buyer('Maharashtra');
    const orderId = await orderOf(b, [variantA, variantB]);
    await prisma.orderItem.updateMany({ where: { orderId, pricePaise: 224_000 }, data: { status: 'CANCELLED' } });
    const inv = (await call<TaxInvoice[]>('GET', `/api/orders/${orderId}/invoices`, b.token)).json.data[0]!;
    expect(inv.lines.map((l) => l.unitPricePaise)).toEqual([112_000]);
  });

  it('is not issued before a prepaid order is paid, and is nobody else’s to read', async () => {
    const b = await buyer('Maharashtra');
    const unpaid = await orderOf(b, [variantA], 'UPI');
    expect((await call('GET', `/api/orders/${unpaid}/invoices`, b.token)).json.error?.code).toBe('ORDER_NOT_PAID');

    const paidLater = await orderOf(b, [variantA]);
    const stranger = await buyer('Maharashtra');
    expect((await call('GET', `/api/orders/${paidLater}/invoices`, stranger.token)).status).toBe(404);
  });
});

describe('GSTIN', () => {
  async function pendingSeller(gstNumber: string | null) {
    seq += 1;
    const user = await prisma.user.create({ data: { phone: `91981${String(seq).padStart(5, '0')}`, name: `Gst Seller ${seq}`, role: Role.SELLER, referralCode: `GST-${seq}` } });
    return prisma.sellerProfile.create({ data: { userId: user.id, shopName: `Gst Shop ${seq}`, status: SellerStatus.PENDING, gstNumber } });
  }

  it('is required to approve a seller', async () => {
    const without = await pendingSeller(null);
    const refused = await call('PATCH', `/api/admin/sellers/${without.id}/status`, adminToken, { action: 'approve', acknowledgeKycWarnings: true });
    expect(refused.status).toBe(400);
    expect(refused.json.error?.code).toBe('GSTIN_REQUIRED');

    const withGstin = await pendingSeller('27ABCDE1234F1Z5');
    const ok = await call('PATCH', `/api/admin/sellers/${withGstin.id}/status`, adminToken, { action: 'approve', acknowledgeKycWarnings: true });
    expect(ok.status).toBe(200);
  });

  it('is required for a payout: an approved seller without one is held, with a banner', async () => {
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { gstNumber: null } });
    expect((await call<{ hasGstin: boolean }>('GET', '/api/seller/profile', sellerToken)).json.data.hasGstin).toBe(false);
    const overview = await call<{ gstinBlock: { code: string } | null }>('GET', '/api/seller/payouts/overview', sellerToken);
    expect(overview.json.data.gstinBlock?.code).toBe('GSTIN_REQUIRED');
    const request = await call('POST', '/api/seller/payouts/request', sellerToken, {});
    expect(request.status).toBe(403);
    expect(request.json.error?.code).toBe('GSTIN_REQUIRED');

    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { gstNumber: '27ABCDE1234F1Z5' } });
    expect((await call<{ hasGstin: boolean }>('GET', '/api/seller/profile', sellerToken)).json.data.hasGstin).toBe(true);
    expect((await call<{ gstinBlock: unknown }>('GET', '/api/seller/payouts/overview', sellerToken)).json.data.gstinBlock).toBeNull();
  });
});
