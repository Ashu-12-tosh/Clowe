import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { brandAuthResetIfChanged } from '../services/brandAuthorization';
import { signAccessToken } from '../utils/jwt';

/**
 * The returns rule shoppers see (48-hour claims, or "Not returnable"); the
 * "Sold by" box (Consumer Protection (E-Commerce) Rules); a seller without a
 * business address stays hidden; a brand marked "authorization required"
 * stays hidden until its document is approved.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let sellerToken: string;
let categoryId: string;
let withAddress: { sellerId: string; slug: string; productSlug: string; productId: string };
let noAddress: { sellerId: string; slug: string; productSlug: string };
let brandId: string;

async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

async function product(sellerId: string, title: string, brand: string | null, i: number) {
  return prisma.product.create({
    data: {
      sellerId, categoryId, title, brand, slug: `sb-${i}-${Date.now()}`, description: 'Sold-by test listing.', basePricePaise: 99_900,
      status: ProductStatus.APPROVED, approvedAt: new Date(),
      variants: { create: [{ optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: `SB-${i}-${Date.now()}`, pricePaise: 99_900, stock: 5 }] },
    },
  });
}

beforeAll(async () => {
  categoryId = (await prisma.category.create({ data: { name: 'Sold-by Gadgets', slug: `sb-gadgets-${Date.now()}`, isActive: true } })).id;
  const u1 = await prisma.user.create({ data: { phone: '9177600001', name: 'SB Seller', email: 'sb.owner@example.com', role: Role.SELLER, referralCode: 'SB-1' } });
  const s1 = await prisma.sellerProfile.create({
    data: {
      userId: u1.id, shopName: 'Gadget Galli', panName: 'GADGET GALLI TRADERS', gstNumber: '27ABCDE1234F1Z5', slug: `gadget-galli-${Date.now()}`,
      status: SellerStatus.APPROVED, approvedAt: new Date(),
      addressLine1: '12 MG Road', addressLine2: 'Shop 4', city: 'Pune', state: 'Maharashtra', pincode: '411001',
      storePhone: '9822000000', storeEmail: 'care@gadgetgalli.in',
    },
  });
  const p1 = await product(s1.id, 'Galli Power Bank', 'Galli', 1);
  withAddress = { sellerId: s1.id, slug: s1.slug!, productSlug: p1.slug, productId: p1.id };
  const u2 = await prisma.user.create({ data: { phone: '9177600002', name: 'No Address', role: Role.SELLER, referralCode: 'SB-2' } });
  const s2 = await prisma.sellerProfile.create({ data: { userId: u2.id, shopName: 'Nowhere Store', slug: `nowhere-${Date.now()}`, status: SellerStatus.APPROVED, approvedAt: new Date(), city: 'Delhi' } });
  const p2 = await product(s2.id, 'Nowhere Charger', null, 2);
  noAddress = { sellerId: s2.id, slug: s2.slug!, productSlug: p2.slug };
  brandId = (await prisma.brand.create({ data: { name: 'Fruitco', slug: `fruitco-${Date.now()}` } })).id;
  const admin = await prisma.user.create({ data: { phone: '9177600003', name: 'SB Admin', role: Role.ADMIN, referralCode: 'SB-3' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  sellerToken = signAccessToken({ sub: u1.id, role: 'SELLER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await prisma.brand.update({ where: { id: brandId }, data: { authorizationRequired: false } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the product page', () => {
  it('shows the claim rule, never a day window, and the full "Sold by" box', async () => {
    const r = await call<Record<string, unknown> & { seller: Record<string, unknown> }>('GET', `/api/products/${withAddress.productSlug}`, null);
    expect(r.status).toBe(200);
    expect(r.json.data.returnWindowDays).toBeUndefined();
    expect(r.json.data).toMatchObject({ returnable: true, claimWindowHours: 48, returnRule: '48-hour claim window for damaged, wrong or defective items' });
    expect(r.json.data.seller).toMatchObject({
      shopName: 'Gadget Galli',
      legalName: 'GADGET GALLI TRADERS',
      address: '12 MG Road, Shop 4, Pune, Maharashtra 411001',
      customerCarePhone: '9822000000',
      customerCareEmail: 'care@gadgetgalli.in',
      gstin: '27ABCDE1234F1Z5',
    });
  });
});

describe('a seller without a business address', () => {
  it('stays hidden from shoppers, and admins and the seller are told', async () => {
    expect((await call('GET', `/api/products/${noAddress.productSlug}`, null)).status).toBe(404);
    expect((await call('GET', `/api/stores/${noAddress.slug}`, null)).status).toBe(404);
    const list = await call<{ items: { slug: string }[] }>('GET', `/api/products?category=${encodeURIComponent((await prisma.category.findUniqueOrThrow({ where: { id: categoryId } })).slug)}`, null);
    expect(list.json.data.items.map((p) => p.slug)).toEqual([withAddress.productSlug]);
    const rows = await call<{ rows: { id: string; addressMissing: boolean }[] }>('GET', '/api/admin/sellers?pageSize=100', adminToken);
    expect(rows.json.data.rows.find((r) => r.id === noAddress.sellerId)?.addressMissing).toBe(true);
    expect(rows.json.data.rows.find((r) => r.id === withAddress.sellerId)?.addressMissing).toBe(false);
    const own = signAccessToken({ sub: (await prisma.sellerProfile.findUniqueOrThrow({ where: { id: noAddress.sellerId } })).userId, role: 'SELLER' });
    expect((await call<{ addressComplete: boolean }>('GET', '/api/seller/profile', own)).json.data.addressComplete).toBe(false);
  });

  it('is shown again once the address is filled', async () => {
    await prisma.sellerProfile.update({ where: { id: noAddress.sellerId }, data: { addressLine1: '5 Chandni Chowk', state: 'Delhi', pincode: '110006' } });
    const r = await call<{ seller: { address: string; customerCarePhone: string; gstin: string | null } }>('GET', `/api/products/${noAddress.productSlug}`, null);
    expect(r.status).toBe(200);
    // Contact falls back to the account's phone; no GSTIN is said plainly by the page.
    expect(r.json.data.seller).toMatchObject({ address: '5 Chandni Chowk, Delhi, Delhi 110006', customerCarePhone: '9177600002', gstin: null });
  });
});

describe('brand authorization', () => {
  let doc: string;

  it('an admin marks a brand: its listings (any spelling) hide until a document is approved', async () => {
    const p = await product(withAddress.sellerId, 'Fruitco Phone 1', 'FRUITCO', 3);
    const slug = p.slug;
    expect((await call('GET', `/api/products/${slug}`, null)).status).toBe(200);
    const mark = await call('PATCH', `/api/admin/brands/${brandId}`, adminToken, { authorizationRequired: true });
    expect(mark.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300)); // the audit entry is written in the background
    expect(await prisma.auditLog.count({ where: { entityType: 'Brand', entityId: brandId, action: 'Brand authorization required' } })).toBe(1);
    expect((await call('GET', `/api/products/${slug}`, null)).status).toBe(404);
    const brands = await call<{ id: string; authorizationRequired: boolean }[]>('GET', '/api/admin/brands', adminToken);
    expect(brands.json.data.find((b) => b.id === brandId)?.authorizationRequired).toBe(true);
    // Other brands are untouched.
    expect((await call('GET', `/api/products/${withAddress.productSlug}`, null)).status).toBe(200);

    // The seller sees where it stands, uploads a document: waiting for review, still hidden.
    const mine = await call<{ rows: { id: string; brandAuth: { status: string } | null }[] }>('GET', '/api/seller/products?pageSize=50', sellerToken);
    expect(mine.json.data.rows.find((r) => r.id === p.id)?.brandAuth?.status).toBe('NONE');
    expect(mine.json.data.rows.find((r) => r.id === withAddress.productId)?.brandAuth).toBeNull();
    const form = new FormData();
    form.append('document', new Blob([Buffer.from('%PDF-1.4\n%brand letter\n')], { type: 'application/pdf' }), 'letter.pdf');
    const up = await fetch(`${base}/api/uploads/seller-document`, { method: 'POST', headers: { authorization: `Bearer ${sellerToken}` }, body: form });
    doc = ((await up.json()) as { data: { ref: string } }).data.ref;
    const sent = await call<{ brandAuth: { status: string; docUrl: string } }>('PUT', `/api/seller/products/${p.id}/brand-authorization`, sellerToken, { doc });
    expect(sent.json.data.brandAuth.status).toBe('PENDING');
    expect(sent.json.data.brandAuth.docUrl).toBeTruthy();
    expect((await call('GET', `/api/products/${slug}`, null)).status).toBe(404);
    // Not needed for a brand without the rule.
    expect((await call('PUT', `/api/seller/products/${withAddress.productId}/brand-authorization`, sellerToken, { doc })).json.error?.code).toBe('BRAND_AUTH_NOT_NEEDED');

    // Admins review it: a rejection needs a reason and tells the seller.
    const queue = await call<{ id: string; brandAuth: { status: string; docUrl: string | null } }[]>('GET', '/api/admin/products?status=BRAND_AUTH', adminToken);
    expect(queue.json.data.find((r) => r.id === p.id)?.brandAuth).toMatchObject({ status: 'PENDING' });
    expect((await call('POST', `/api/admin/products/${p.id}/brand-authorization`, adminToken, { decision: 'REJECT' })).status).toBe(400);
    await call('POST', `/api/admin/products/${p.id}/brand-authorization`, adminToken, { decision: 'REJECT', note: 'The letter is not signed' });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).brandAuthStatus).toBe('REJECTED');
    expect(await prisma.notification.findFirst({ where: { type: 'BRAND_AUTH', body: { contains: 'not signed' } } })).toBeTruthy();
    expect((await call('GET', `/api/products/${slug}`, null)).status).toBe(404);

    // A new document, approved: the listing is shown.
    await call('PUT', `/api/seller/products/${p.id}/brand-authorization`, sellerToken, { doc });
    const ok = await call('POST', `/api/admin/products/${p.id}/brand-authorization`, adminToken, { decision: 'APPROVE' });
    expect(ok.status).toBe(200);
    expect((await call('GET', `/api/products/${slug}`, null)).status).toBe(200);
    // Nothing waiting any more.
    expect((await call('POST', `/api/admin/products/${p.id}/brand-authorization`, adminToken, { decision: 'APPROVE' })).json.error?.code).toBe('NO_BRAND_DOC_PENDING');
  });

  it('a listing linked to the brand by id hides too, and a new brand resets the approval', async () => {
    const p = await prisma.product.update({ where: { id: withAddress.productId }, data: { brandId } });
    expect((await call('GET', `/api/products/${withAddress.productSlug}`, null)).status).toBe(404);
    expect(brandAuthResetIfChanged({ brand: 'Fruitco', brandId }, { brand: ' fruitco ', brandId })).toEqual({});
    expect(brandAuthResetIfChanged({ brand: 'Fruitco', brandId }, { brand: 'Other', brandId: null })).toMatchObject({ brandAuthStatus: 'NONE', brandAuthDoc: null });
    await prisma.product.update({ where: { id: p.id }, data: { brandId: null } });
    expect((await call('GET', `/api/products/${withAddress.productSlug}`, null)).status).toBe(200);
  });
});
