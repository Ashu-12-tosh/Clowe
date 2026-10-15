import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * Banner and tile images from admin: category banners (their own screen),
 * a category's tile picture, and the image on hero banners and promo tiles —
 * set by upload or URL, replaced, and removed.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let sellerToken: string;
let categoryId: string;
let categorySlug: string;

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data?: unknown; error?: { code: string; message: string; field?: string } } };
}

const IMG = 'https://cdn.example.com/banner-2000x750.jpg';

beforeAll(async () => {
  const admin = await prisma.user.create({
    data: { phone: '9196100001', name: 'Banner Admin', role: Role.ADMIN, referralCode: 'BANNER-A' },
  });
  const seller = await prisma.user.create({
    data: { phone: '9196100002', name: 'Banner Seller', role: Role.SELLER, referralCode: 'BANNER-S' },
  });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  sellerToken = signAccessToken({ sub: seller.id, role: 'SELLER' });
  const category = await prisma.category.create({ data: { name: 'Banner Test Dept', slug: 'banner-test-dept' } });
  categoryId = category.id;
  categorySlug = category.slug;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await prisma.category.deleteMany({ where: { id: categoryId } });
  await prisma.homeBanner.deleteMany({ where: { headline: { startsWith: 'Banner test' } } });
  await prisma.promoTile.deleteMany({ where: { title: { startsWith: 'Banner test' } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('category banners', () => {
  it('are created, edited, switched off and deleted from admin, and shown on the category page while live', async () => {
    const created = await call('POST', '/api/admin/category-banners', adminToken, {
      categoryId,
      eyebrow: 'New season',
      headline: 'Dress the',
      highlight: 'New You.',
      imageUrl: IMG,
    });
    expect(created.status).toBe(200);
    const row = created.json.data as { id: string; categoryName: string; primaryLabel: string; primaryHref: string | null };
    expect(row).toMatchObject({ categoryName: 'Banner Test Dept', primaryLabel: 'Shop Now', primaryHref: null });

    const page = async () =>
      ((await call('GET', `/api/categories/${categorySlug}`, null)).json.data as { banners: { headline: string; imageUrl: string | null }[] }).banners;
    expect(await page()).toEqual([expect.objectContaining({ headline: 'Dress the', imageUrl: IMG })]);

    const edited = await call('PATCH', `/api/admin/category-banners/${row.id}`, adminToken, { imageUrl: null, primaryHref: '' });
    expect(edited.json.data).toMatchObject({ imageUrl: null, primaryHref: null });

    const list = await call('GET', `/api/admin/category-banners?categoryId=${categoryId}`, adminToken);
    expect(list.json.data).toEqual([expect.objectContaining({ id: row.id, imageUrl: null })]);

    await call('PATCH', `/api/admin/category-banners/${row.id}`, adminToken, { isActive: false });
    expect(await page()).toEqual([]);

    expect((await call('DELETE', `/api/admin/category-banners/${row.id}`, adminToken)).status).toBe(200);
    expect((await call('DELETE', `/api/admin/category-banners/${row.id}`, adminToken)).status).toBe(404);
  });

  it('refuse a bad image link, naming the field, and a category that does not exist', async () => {
    const bad = await call('POST', '/api/admin/category-banners', adminToken, { categoryId, headline: 'Bad image', imageUrl: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatchObject({ field: 'imageUrl' });
    const missing = await call('POST', '/api/admin/category-banners', adminToken, { categoryId: 'nope', headline: 'No category' });
    expect(missing.status).toBe(400);
  });

  it('are admin only', async () => {
    expect((await call('GET', '/api/admin/category-banners', sellerToken)).status).toBe(403);
    expect((await call('POST', '/api/admin/category-banners', null, { categoryId, headline: 'Anon' })).status).toBe(401);
  });
});

describe('a category tile picture', () => {
  it('is set, shown to admin, and removed', async () => {
    const tile = 'https://cdn.example.com/tile-600.jpg';
    expect((await call('PATCH', `/api/admin/categories/${categoryId}`, adminToken, { imageUrl: tile })).status).toBe(200);
    const rows = (await call('GET', '/api/admin/categories', adminToken)).json.data as { id: string; imageUrl: string | null }[];
    expect(rows.find((r) => r.id === categoryId)?.imageUrl).toBe(tile);
    await call('PATCH', `/api/admin/categories/${categoryId}`, adminToken, { imageUrl: null });
    expect((await prisma.category.findUniqueOrThrow({ where: { id: categoryId } })).imageUrl).toBeNull();
  });
});

describe('hero banner and promo tile images', () => {
  it('can be added to, replaced on and removed from an existing one', async () => {
    const banner = await call('POST', '/api/admin/banners', adminToken, { headline: 'Banner test hero' });
    const bannerId = (banner.json.data as { id: string }).id;
    await call('PATCH', `/api/admin/banners/${bannerId}`, adminToken, { imageUrl: IMG });
    expect((await prisma.homeBanner.findUniqueOrThrow({ where: { id: bannerId } })).imageUrl).toBe(IMG);
    await call('PATCH', `/api/admin/banners/${bannerId}`, adminToken, { imageUrl: null });
    expect((await prisma.homeBanner.findUniqueOrThrow({ where: { id: bannerId } })).imageUrl).toBeNull();

    const tile = await call('POST', '/api/admin/promos', adminToken, { placement: 'PROMO_STRIP', title: 'Banner test strip', imageUrl: IMG });
    const tileId = (tile.json.data as { id: string }).id;
    await call('PATCH', `/api/admin/promos/${tileId}`, adminToken, { imageUrl: '/uploads/strip.webp' });
    expect((await prisma.promoTile.findUniqueOrThrow({ where: { id: tileId } })).imageUrl).toBe('/uploads/strip.webp');
  });
});
