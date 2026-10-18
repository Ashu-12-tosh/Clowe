import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';

/**
 * A renamed listing keeps its old URLs: /api/products/slug-redirects maps each
 * old slug to the current one, and the web middleware answers the old URL with
 * a 301 to the new one.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let productId: string;
let currentSlug: string;

beforeAll(async () => {
  await seedFixture(prisma);
  const product = await prisma.product.findFirstOrThrow({ where: { status: 'APPROVED' }, orderBy: { createdAt: 'asc' } });
  productId = product.id;
  currentSlug = product.slug;
  await prisma.productSlugRedirect.deleteMany({ where: { productId } });
  await prisma.productSlugRedirect.createMany({
    data: [
      { oldSlug: 'old-weak-title-abc123', productId },
      // Renamed back to a slug it once had: never a redirect to itself.
      { oldSlug: currentSlug, productId },
    ],
  });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await prisma.productSlugRedirect.deleteMany({ where: { productId } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('GET /api/products/slug-redirects', () => {
  it('maps an old slug to the current one, and never a slug to itself', async () => {
    const res = await fetch(`${base}/api/products/slug-redirects`);
    expect(res.status).toBe(200);
    const map = ((await res.json()) as { data: Record<string, string> }).data;
    expect(map['old-weak-title-abc123']).toBe(currentSlug);
    expect(map[currentSlug]).toBeUndefined();
  });

  it('is not read as a product slug', async () => {
    const res = await fetch(`${base}/api/products/${currentSlug}`);
    expect(res.status).toBe(200);
  });

  it('follows the product when it is renamed again', async () => {
    const renamed = `${currentSlug}-renamed`;
    await prisma.product.update({ where: { id: productId }, data: { slug: renamed } });
    try {
      const map = ((await (await fetch(`${base}/api/products/slug-redirects`)).json()) as { data: Record<string, string> }).data;
      expect(map['old-weak-title-abc123']).toBe(renamed);
      expect(map[currentSlug]).toBe(renamed);
    } finally {
      await prisma.product.update({ where: { id: productId }, data: { slug: currentSlug } });
    }
  });
});
