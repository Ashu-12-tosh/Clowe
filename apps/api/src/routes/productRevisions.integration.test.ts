import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminProductDetail, AdminProductRow, SellerProductDetail } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * Editing a live listing. Content changes wait for review while buyers keep
 * the approved version — on the storefront and in their carts; price and
 * stock save at once; a draft never takes the listing down; pictures are
 * only rewritten when they changed.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
let adminToken: string;
let seq = 0;

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirst({ where: { isActive: true, parentId: { not: null } } });
  categoryId = category!.id;
  const admin = await prisma.user.create({ data: { phone: '9110000000', name: 'Rev Admin', role: Role.ADMIN, referralCode: 'REV-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** A seller with one listing in the given state: two pictures, one variant. */
async function listing(status: ProductStatus = ProductStatus.APPROVED) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `91100${String(seq).padStart(5, '0')}`, name: `Rev Seller ${seq}`, role: Role.SELLER, referralCode: `REV-S-${seq}` },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Rev Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      categoryId,
      title: 'Original Title',
      slug: `rev-product-${seq}`,
      description: 'The approved description.',
      basePricePaise: 50_000,
      status,
      approvedAt: status === ProductStatus.APPROVED ? new Date() : null,
      images: { create: [{ url: '/uploads/demo/a.jpg', sortOrder: 0 }, { url: '/uploads/demo/b.jpg', sortOrder: 1 }] },
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
      sku: `REV-SKU-${seq}`,
      pricePaise: 50_000,
      stock: 10,
    },
  });
  return { token: signAccessToken({ sub: user.id, role: 'SELLER' }), userId: user.id, product, variant };
}

type Listing = Awaited<ReturnType<typeof listing>>;

/** The form's body for this listing, with whatever the test changes. */
function body(l: Listing, changes: Record<string, unknown> = {}) {
  return {
    title: 'Original Title',
    categoryId,
    description: 'The approved description.',
    imageUrls: ['/uploads/demo/a.jpg', '/uploads/demo/b.jpg'],
    variants: [{ id: l.variant.id, optionValues: { size: 'M' }, sellerPricePaise: 50_000, stock: 10 }],
    weightGrams: 350,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 50,
    mode: 'SUBMIT',
    ...changes,
  };
}

async function call(method: string, path: string, token: string, payload?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, json: (await res.json()) as { success: boolean; data: unknown; error?: { code: string } } };
}

const save = (l: Listing, changes: Record<string, unknown> = {}) =>
  call('PUT', `/api/seller/products/${l.product.id}`, l.token, body(l, changes));

const imageIds = async (productId: string) =>
  (await prisma.productImage.findMany({ where: { productId }, orderBy: { sortOrder: 'asc' } })).map((i) => i.id);

describe('a live listing', () => {
  it('saves price and stock straight away, stays live, and leaves its pictures alone', async () => {
    const l = await listing();
    const before = await imageIds(l.product.id);
    const res = await save(l, { variants: [{ id: l.variant.id, optionValues: { size: 'M' }, sellerPricePaise: 45_000, stock: 3 }] });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'APPROVED', revisionStatus: null });
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: l.variant.id } });
    // The seller's price is before GST; buyers pay it plus 18% (no category rule).
    expect([variant.sellerPricePaise, variant.pricePaise, variant.stock]).toEqual([45_000, 53_100, 3]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: l.product.id } })).status).toBe('APPROVED');
    expect(await prisma.productRevision.count({ where: { productId: l.product.id } })).toBe(0);
    expect(await imageIds(l.product.id)).toEqual(before);
  });

  it('keeps showing the approved content, and stays in carts, while a content edit waits for review', async () => {
    const l = await listing();
    const shopper = await prisma.user.create({ data: { phone: `9120000${seq}`.slice(0, 10), name: 'Cart Shopper', referralCode: `REV-C-${seq}` } });
    await prisma.cart.create({ data: { userId: shopper.id, items: { create: { variantId: l.variant.id, quantity: 1 } } } });

    const res = await save(l, { title: 'A Better Title', variants: [{ id: l.variant.id, optionValues: { size: 'M' }, sellerPricePaise: 48_000, stock: 10 }] });
    expect(res.json.data).toMatchObject({ status: 'APPROVED', revisionStatus: 'PENDING' });

    const product = await prisma.product.findUniqueOrThrow({ where: { id: l.product.id } });
    expect(product).toMatchObject({ status: 'APPROVED', title: 'Original Title' });
    // The price in the same save went live anyway.
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: l.variant.id } })).sellerPricePaise).toBe(48_000);
    const storefront = await fetch(`${base}/api/products/${l.product.slug}`);
    expect(storefront.status).toBe(200);
    expect(((await storefront.json()) as { data: { title: string } }).data.title).toBe('Original Title');
    expect(await prisma.cartItem.count({ where: { variantId: l.variant.id } })).toBe(1);

    // The seller's form shows the edit, and says it is waiting.
    const detail = (await call('GET', `/api/seller/products/${l.product.id}`, l.token)).json.data as SellerProductDetail;
    expect(detail.title).toBe('A Better Title');
    expect(detail.revision?.status).toBe('PENDING');
  });

  it('never goes down for a saved draft: the edit is kept, not reviewed, not live', async () => {
    const l = await listing();
    const res = await save(l, { title: 'Draft Title', mode: 'DRAFT' });
    expect(res.json.data).toMatchObject({ status: 'APPROVED', revisionStatus: 'DRAFT' });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: l.product.id } })).status).toBe('APPROVED');
    const queue = (await call('GET', '/api/admin/products?status=REVISION', adminToken)).json.data as AdminProductRow[];
    expect(queue.map((r) => r.id)).not.toContain(l.product.id);
  });

  it('drops the edit when the seller puts the content back as it was', async () => {
    const l = await listing();
    await save(l, { title: 'Changed Mind' });
    const res = await save(l);
    expect(res.json.data).toMatchObject({ revisionStatus: null });
    expect(await prisma.productRevision.count({ where: { productId: l.product.id } })).toBe(0);
  });

  it('refuses to drop every live variant while new ones would wait for review', async () => {
    const l = await listing();
    const res = await save(l, { variants: [{ optionValues: { size: 'L' }, sellerPricePaise: 50_000, stock: 1 }] });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('LIVE_VARIANT_REQUIRED');
  });
});

describe('reviewing an edit', () => {
  it('approval puts the edit live, adds new variants, and rewrites only the pictures that changed', async () => {
    const l = await listing();
    const before = await imageIds(l.product.id);
    await save(l, {
      title: 'Approved Title',
      variants: [
        { id: l.variant.id, optionValues: { size: 'M' }, sellerPricePaise: 50_000, stock: 10 },
        { optionValues: { size: 'L' }, sellerPricePaise: 52_000, stock: 4 },
      ],
    });
    const queue = (await call('GET', '/api/admin/products?status=REVISION', adminToken)).json.data as AdminProductRow[];
    expect(queue.map((r) => r.id)).toContain(l.product.id);
    const review = (await call('GET', `/api/admin/products/${l.product.id}`, adminToken)).json.data as AdminProductDetail;
    expect(review.title).toBe('Original Title');
    expect(review.revision?.changedFields).toEqual(['title', 'newVariants']);

    expect((await call('PATCH', `/api/admin/products/${l.product.id}/revision`, adminToken, { action: 'approve' })).status).toBe(200);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: l.product.id }, include: { variants: true } });
    expect(product).toMatchObject({ status: 'APPROVED', title: 'Approved Title' });
    expect(product.variants.map((v) => v.label).sort()).toEqual(['L', 'M']);
    expect(await prisma.productRevision.count({ where: { productId: l.product.id } })).toBe(0);
    expect(await imageIds(l.product.id)).toEqual(before);
  });

  it('approval of new pictures replaces them', async () => {
    const l = await listing();
    await save(l, { imageUrls: ['/uploads/demo/c.jpg'] });
    await call('PATCH', `/api/admin/products/${l.product.id}/revision`, adminToken, { action: 'approve' });
    const urls = (await prisma.productImage.findMany({ where: { productId: l.product.id } })).map((i) => i.url);
    expect(urls).toEqual(['/uploads/demo/c.jpg']);
  });

  it('rejection leaves the listing exactly as it was, and tells the seller why', async () => {
    const l = await listing();
    await save(l, { title: 'Rejected Title' });
    const res = await call('PATCH', `/api/admin/products/${l.product.id}/revision`, adminToken, { action: 'reject', reason: 'Misleading title' });
    expect(res.status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: l.product.id } })).title).toBe('Original Title');
    const detail = (await call('GET', `/api/seller/products/${l.product.id}`, l.token)).json.data as SellerProductDetail;
    expect(detail.revision).toMatchObject({ status: 'REJECTED', rejectionReason: 'Misleading title' });
    expect(await prisma.notification.count({ where: { userId: l.userId, type: 'PRODUCT_EDIT_REJECTED' } })).toBe(1);
  });
});

describe('the parcel (weight and size)', () => {
  const noParcel = { weightGrams: null, lengthMm: null, widthMm: null, heightMm: null };

  it('is needed to send a listing to review, not to save a draft', async () => {
    const l = await listing(ProductStatus.DRAFT);
    const submitted = await save(l, { ...noParcel });
    expect(submitted.status).toBe(400);
    expect(submitted.json.error?.code).toBe('SHIPPING_DETAILS_REQUIRED');
    expect((await save(l, { ...noParcel, mode: 'DRAFT' })).status).toBe(200);
  });

  it('is not needed for a price change on a live listing, only for an edit sent to review', async () => {
    const l = await listing();
    const price = await save(l, { ...noParcel, variants: [{ id: l.variant.id, optionValues: { size: 'M' }, sellerPricePaise: 41_000, stock: 10 }] });
    expect(price.status).toBe(200);
    const edit = await save(l, { ...noParcel, title: 'Needs A Parcel' });
    expect(edit.json.error?.code).toBe('SHIPPING_DETAILS_REQUIRED');
  });

  it('refuses a weight entered in grams where kilograms were meant', async () => {
    const l = await listing(ProductStatus.DRAFT);
    const res = await save(l, { weightGrams: 3_500_000 });
    expect(res.status).toBe(400);
  });
});

describe('a listing that is not live yet', () => {
  it('is edited directly, as before, keeping its pictures when they did not change', async () => {
    const l = await listing(ProductStatus.PENDING);
    const before = await imageIds(l.product.id);
    const res = await save(l, { title: 'Pending Edit' });
    expect(res.json.data).toMatchObject({ status: 'PENDING' });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: l.product.id } })).title).toBe('Pending Edit');
    expect(await prisma.productRevision.count({ where: { productId: l.product.id } })).toBe(0);
    expect(await imageIds(l.product.id)).toEqual(before);
  });
});

/**
 * The shipping template is hidden from the product form until the courier
 * integration gives it meaning. Saving a listing must leave what is stored
 * alone, including when an old form still sends one.
 */
describe('the shipping template', () => {
  const template = async (productId: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).shippingTemplate;

  it('is kept when a live listing is saved without it, or with a stale one', async () => {
    const l = await listing();
    await prisma.product.update({ where: { id: l.product.id }, data: { shippingTemplate: 'EXPRESS' } });
    expect((await save(l, { title: 'Edited Title' })).status).toBe(200);
    expect(await template(l.product.id)).toBe('EXPRESS');
    expect((await save(l, { shippingTemplate: 'HEAVY' })).status).toBe(200);
    expect(await template(l.product.id)).toBe('EXPRESS');
  });

  it('is kept when a draft is saved', async () => {
    const l = await listing(ProductStatus.DRAFT);
    await prisma.product.update({ where: { id: l.product.id }, data: { shippingTemplate: 'HEAVY' } });
    expect((await save(l, { title: 'Draft Title', mode: 'DRAFT' })).status).toBe(200);
    expect(await template(l.product.id)).toBe('HEAVY');
  });
});
