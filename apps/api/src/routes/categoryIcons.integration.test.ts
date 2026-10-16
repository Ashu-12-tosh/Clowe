import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';

// A category page's subcategory tiles: each child carries its own icon (set
// on it, else from the subcategory list, else the parent's), and an image
// uploaded in admin comes through to win over it on the tile.

const prisma = new PrismaClient();
let server: Server;
let base: string;
const ROOT = 'icon-test-root';
const UPLOADED = '/uploads/icon-test-tile.webp';

async function upsert(slug: string, data: { name: string; parentId?: string; icon?: string | null; imageUrl?: string | null; sortOrder: number }) {
  return prisma.category.upsert({ where: { slug }, create: { slug, isActive: true, ...data }, update: { isActive: true, ...data } });
}

beforeAll(async () => {
  const root = await upsert(ROOT, { name: 'Icon Test', icon: '🧪', sortOrder: 900 });
  await upsert('books-fiction', { name: 'Fiction', parentId: root.id, icon: null, imageUrl: null, sortOrder: 0 });
  await upsert('books-academic', { name: 'Academic', parentId: root.id, icon: null, imageUrl: UPLOADED, sortOrder: 1 });
  await upsert('icon-test-own', { name: 'Own Icon', parentId: root.id, icon: '🐉', imageUrl: null, sortOrder: 2 });
  await upsert('icon-test-unlisted', { name: 'Unlisted', parentId: root.id, icon: null, imageUrl: null, sortOrder: 3 });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // Switched off, so other suites' category trees stay as they were.
  await prisma.category.updateMany({
    where: { slug: { in: [ROOT, 'books-fiction', 'books-academic', 'icon-test-own', 'icon-test-unlisted'] } },
    data: { isActive: false },
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('subcategory tile icons', () => {
  it('on the category page', async () => {
    const res = await fetch(`${base}/api/categories/${ROOT}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { children: { slug: string; icon: string | null; imageUrl: string | null }[] } };
    const bySlug = Object.fromEntries(data.children.map((c) => [c.slug, c]));
    expect(bySlug['books-fiction']).toMatchObject({ icon: '📖', imageUrl: null });
    // The uploaded image is still sent; the tile shows it instead of the icon.
    expect(bySlug['books-academic']).toMatchObject({ icon: '🎓', imageUrl: expect.stringContaining('icon-test-tile') });
    expect(bySlug['icon-test-own']!.icon).toBe('🐉');
    expect(bySlug['icon-test-unlisted']!.icon).toBe('🧪');
  });

  it('in the category tree', async () => {
    const { data } = (await (await fetch(`${base}/api/categories`)).json()) as { data: { slug: string; children: { slug: string; icon: string | null }[] }[] };
    const root = data.find((c) => c.slug === ROOT)!;
    expect(Object.fromEntries(root.children.map((c) => [c.slug, c.icon]))).toMatchObject({
      'books-fiction': '📖',
      'icon-test-own': '🐉',
      'icon-test-unlisted': '🧪',
    });
  });
});
