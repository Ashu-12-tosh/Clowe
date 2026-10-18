import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import type { SellerPayoutOverview, StoreOpenChecklistRow } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { splitStock } from '../services/adminListingEdit';
import { invalidateCategoryRules } from '../services/categoryRules';
import { endExceptionsOnStoreOpen } from '../services/onboardingException';
import { getSettings, setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * An admin's onboarding exception: a seller's approved listings may be live
 * before the address or KYC is complete, until the store opens for orders (or
 * the end date) — with Clowe's contact in the "Sold by" box, and never for
 * payouts. The store cannot open while a live seller is incomplete. And an
 * admin's listing edit (sizes, brand, text), on the record before and after.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let sellerToken: string;
let sellerId: string;
let categoryId: string;
let slug: string;
let productId: string;
let wasOpen: boolean;
let adminId: string;

async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

const audited = async (action: string, entityId: string) => {
  await new Promise((r) => setTimeout(r, 300));
  return prisma.auditLog.findMany({ where: { action, entityId } });
};

beforeAll(async () => {
  wasOpen = (await getSettings()).storeOpenForOrders;
  await setSetting('storeOpenForOrders', false); // pre-launch, as on production
  categoryId = (await prisma.category.create({ data: { name: 'Exception Wear', slug: `ex-wear-${Date.now()}`, isActive: true } })).id;
  const u = await prisma.user.create({ data: { phone: '9177800001', name: 'Known Seller', role: Role.SELLER, referralCode: 'OX-1' } });
  const s = await prisma.sellerProfile.create({
    data: { userId: u.id, shopName: 'Known Shop', slug: `known-${Date.now()}`, status: SellerStatus.APPROVED, approvedAt: new Date(), city: 'Delhi', state: 'Delhi', gstNumber: '07ABCDE1234F1Z5' },
  });
  sellerId = s.id;
  sellerToken = signAccessToken({ sub: u.id, role: 'SELLER' });
  const p = await prisma.product.create({
    data: {
      sellerId, categoryId, title: 'Blue shirt', brand: 'Blue shirt', slug: `ex-blue-${Date.now()}`, description: 'Blue shirt by Blue shirt. Crafted with shirt in mind.', basePricePaise: 149_860,
      status: ProductStatus.APPROVED, approvedAt: new Date(),
      attributes: [{ key: 'country_of_origin', label: 'Country of origin', value: 'Inida' }],
      variants: { create: [{ optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: `EX-${Date.now()}`, pricePaise: 149_860, sellerPricePaise: 127_000, mrpPaise: 259_600, stock: 10 }] },
    },
  });
  slug = p.slug;
  productId = p.id;
  const a = await prisma.user.create({ data: { phone: '9177800002', name: 'Ops Admin', role: Role.ADMIN, referralCode: 'OX-2' } });
  adminToken = signAccessToken({ sub: a.id, role: 'ADMIN' });
  adminId = a.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await setSetting('storeOpenForOrders', wasOpen);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the onboarding exception', () => {
  it('is set by an admin with a reason, on the record', async () => {
    expect((await call('GET', `/api/products/${slug}`, null)).status).toBe(404); // no address: hidden
    expect((await call('PUT', `/api/admin/sellers/${sellerId}/onboarding-exception`, adminToken, { enabled: true })).status).toBe(400);
    const set = await call('PUT', `/api/admin/sellers/${sellerId}/onboarding-exception`, adminToken, { enabled: true, reason: 'Known to the owner; onboarding before launch' });
    expect(set.status).toBe(200);
    expect(await audited('Onboarding exception set', sellerId)).toHaveLength(1);
    const rows = await call<{ rows: { id: string; onboardingException: { enabled: boolean; active: boolean; reason: string } }[] }>('GET', '/api/admin/sellers?pageSize=100', adminToken);
    expect(rows.json.data.rows.find((r) => r.id === sellerId)?.onboardingException).toMatchObject({ enabled: true, active: true, reason: 'Known to the owner; onboarding before launch' });
  });

  it('lets the listing be live, with Clowe as customer care and no unverified GSTIN', async () => {
    const r = await call<{ seller: Record<string, unknown> }>('GET', `/api/products/${slug}`, null);
    expect(r.status).toBe(200);
    const legal = (await getSettings()).legalEntity;
    expect(r.json.data.seller).toMatchObject({
      shopName: 'Known Shop',
      city: 'Delhi',
      address: null,
      contactViaClowe: true,
      gstin: null,
      customerCarePhone: legal.supportPhone || legal.supportPhoneAlt || '',
    });
  });

  it('never covers payouts', async () => {
    const o = (await call<SellerPayoutOverview>('GET', '/api/seller/payouts/overview', sellerToken)).json.data;
    expect(o.gstinBlock?.code).toBe('GSTIN_NOT_VERIFIED');
    expect(o.panBlock).not.toBeNull();
    expect(o.bankBlock).not.toBeNull();
  });

  it('stops holding after its end date', async () => {
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { onboardingExceptionUntil: new Date(Date.now() - 60_000) } });
    expect((await call('GET', `/api/products/${slug}`, null)).status).toBe(404);
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { onboardingExceptionUntil: null } });
    expect((await call('GET', `/api/products/${slug}`, null)).status).toBe(200);
  });
});

describe('opening the store', () => {
  it('is blocked while a live seller lacks an address or verified KYC — exceptions included', async () => {
    const list = await call<StoreOpenChecklistRow[]>('GET', '/api/admin/store-open-checklist', adminToken);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    const mine = list.json.data.find((r) => r.sellerId === sellerId);
    expect(mine).toMatchObject({ onboardingException: true, liveListings: 1 });
    expect(mine!.missing).toEqual(expect.arrayContaining(['business address', 'PAN not verified', 'GSTIN not verified', 'bank account not verified']));
    const open = await call('PUT', '/api/admin/settings', adminToken, { storeOpenForOrders: true });
    expect(open.json.error?.code).toBe('STORE_OPEN_CHECKLIST');
    expect(open.json.error?.message).toContain('Known Shop: business address');
    expect((await getSettings()).storeOpenForOrders).toBe(false);
  });

  it('ends every exception when it opens', async () => {
    expect(await endExceptionsOnStoreOpen(adminId)).toBeGreaterThanOrEqual(1);
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } })).onboardingException).toBe(false);
    expect(await audited('Onboarding exception ended', sellerId)).toHaveLength(1);
    expect((await call('GET', `/api/products/${slug}`, null)).status).toBe(404);
    // And none can be set once the store is open.
    await setSetting('storeOpenForOrders', true);
    expect((await call('PUT', `/api/admin/sellers/${sellerId}/onboarding-exception`, adminToken, { enabled: true, reason: 'Known to the owner' })).json.error?.code).toBe('STORE_ALREADY_OPEN');
    await setSetting('storeOpenForOrders', false);
  });
});

describe('an admin’s listing edit', () => {
  it('splits stock evenly, never below 1', () => {
    expect(splitStock(10, 5)).toEqual([2, 2, 2, 2, 2]);
    expect(splitStock(12, 5)).toEqual([3, 3, 2, 2, 2]);
    expect(splitStock(3, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it('fixes text and brand, adds sizes at today’s price, and keeps every value before and after', async () => {
    expect((await call('PATCH', `/api/admin/products/${productId}/listing`, adminToken, { title: 'Blue shirt' })).status).toBe(400); // a reason is required
    const r = await call<{ before: { title: string; variants: unknown[] }; after: { brand: string; variants: { size: string; stock: number; pricePaise: number }[] } }>(
      'PATCH',
      `/api/admin/products/${productId}/listing`,
      adminToken,
      {
        brand: 'Generic',
        description: 'A blue cotton shirt for men, in sizes S to XXL. Country of origin: India.',
        attributes: [{ key: 'country_of_origin', label: 'Country of origin', value: 'India' }],
        sizes: ['S', 'M', 'L', 'XL', 'XXL'],
        reason: 'Fixes agreed with the seller',
      },
    );
    expect(r.status).toBe(200);
    expect(r.json.data.after.brand).toBe('Generic');
    const order = ['S', 'M', 'L', 'XL', 'XXL'];
    const bySize = [...r.json.data.after.variants].sort((x, y) => order.indexOf(x.size) - order.indexOf(y.size));
    expect(bySize.map((v) => [v.size, v.stock, v.pricePaise])).toEqual([
      ['S', 2, 149_860],
      ['M', 2, 149_860],
      ['L', 2, 149_860],
      ['XL', 2, 149_860],
      ['XXL', 2, 149_860],
    ]);
    const variants = await prisma.productVariant.findMany({ where: { productId, retiredAt: null } });
    expect(variants.every((v) => v.sellerPricePaise === 127_000 && v.mrpPaise === 259_600 && v.optionsKey.startsWith('size='))).toBe(true);
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(p.attributes).toEqual([{ key: 'country_of_origin', label: 'Country of origin', value: 'India' }]);
    const log = await audited('Listing edited by Clowe admin', productId);
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0]!.metadata)).toContain('Inida'); // the value before is kept
  });

  it('sets the pictures in order, each with its internal note, and shows the note to admins', async () => {
    const urls = ['http://localhost:4000/uploads/a-w2000.webp', 'http://localhost:4000/uploads/b-w2000.webp', 'http://localhost:4000/uploads/old.jpg'];
    const r = await call<{ after: { images: { url: string; qualityNote: string | null }[] } }>('PATCH', `/api/admin/products/${productId}/listing`, adminToken, {
      images: [
        { url: urls[0], qualityNote: 'low-res, replace later' },
        { url: urls[1], qualityNote: 'low-res, replace later' },
        { url: urls[2] },
      ],
      reason: 'Seller photos uploaded by Clowe admin',
    });
    expect(r.status).toBe(200);
    expect(r.json.data.after.images).toEqual([
      { url: urls[0], qualityNote: 'low-res, replace later' },
      { url: urls[1], qualityNote: 'low-res, replace later' },
      { url: urls[2], qualityNote: null },
    ]);
    const detail = await call<{ imageUrls: string[]; imageNotes: (string | null)[] }>('GET', `/api/admin/products/${productId}`, adminToken);
    expect(detail.json.data.imageNotes).toEqual(['low-res, replace later', 'low-res, replace later', null]);
    // Shoppers see the pictures, never the note.
    const pub = await call<Record<string, unknown>>('GET', `/api/products/${slug}`, null);
    expect(JSON.stringify(pub.json)).not.toContain('replace later');
  });

  it('moves the listing to another category, for the right HSN code, and keeps both on the record', async () => {
    const shirts = await prisma.category.create({ data: { name: 'Exception Shirts', slug: `ex-shirts-${Date.now()}`, isActive: true, parentId: categoryId, hsnCode: '6205' } });
    const closed = await prisma.category.create({ data: { name: 'Closed', slug: `ex-closed-${Date.now()}`, isActive: false } });
    invalidateCategoryRules();
    const refused = await call('PATCH', `/api/admin/products/${productId}/listing`, adminToken, { categoryId: closed.id, reason: 'Right category for its HSN' });
    expect(refused.status).toBe(400);
    const r = await call<{ before: { category: { id: string; hsnCode: string | null } }; after: { category: { id: string; name: string; hsnCode: string | null } } }>(
      'PATCH',
      `/api/admin/products/${productId}/listing`,
      adminToken,
      { categoryId: shirts.id, reason: 'Right category for its HSN' },
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.before.category).toMatchObject({ id: categoryId, hsnCode: null });
    expect(r.json.data.after.category).toEqual({ id: shirts.id, name: 'Exception Shirts', hsnCode: '6205' });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).categoryId).toBe(shirts.id);
    const [row] = await audited('Listing edited by Clowe admin', productId).then((rows) => rows.filter((x) => x.summary.includes('Right category')));
    expect((row!.metadata as { after: { category: { hsnCode: string } } }).after.category.hsnCode).toBe('6205');
    await prisma.product.update({ where: { id: productId }, data: { categoryId } });
  });

  it('keeps a variant already in one of the sizes, with its order history', async () => {
    const t = await prisma.product.create({
      data: {
        sellerId, categoryId, title: 'Black trousers', slug: `ex-trousers-${Date.now()}`, description: 'Black trousers for testing sizes.', basePricePaise: 117_882,
        status: ProductStatus.APPROVED, approvedAt: new Date(),
        variants: { create: [{ optionValues: { size: 'M', color: 't-shirt' }, optionsKey: 'color=t-shirt|size=M', label: 't-shirt · M', size: 'M', color: 't-shirt', sku: `EXT-${Date.now()}`, pricePaise: 117_882, stock: 20 }] },
      },
      include: { variants: true },
    });
    const mId = t.variants[0]!.id;
    await call('PATCH', `/api/admin/products/${t.id}/listing`, adminToken, { sizes: ['S', 'M', 'L', 'XL', 'XXL'], reason: 'Sizes the seller confirmed' });
    const m = await prisma.productVariant.findUniqueOrThrow({ where: { id: mId } });
    expect(m).toMatchObject({ size: 'M', color: '', label: 'M', stock: 4, retiredAt: null });
    expect(await prisma.productVariant.count({ where: { productId: t.id, retiredAt: null } })).toBe(5);
  });
});
