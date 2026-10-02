import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFixture } from '../test/fixture';
import { picsumFor, replaceLoremflickr } from '../../prisma/replaceLoremflickr';

/** The temporary demo-image fix: loremflickr URLs become stable picsum ones; nothing else moves. */

const prisma = new PrismaClient();

beforeAll(async () => {
  await seedFixture(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('picsumFor', () => {
  it('keeps the size and seeds by the key', () => {
    expect(picsumFor('https://loremflickr.com/800/1000/tshirt?lock=12', 'p1-0')).toBe('https://picsum.photos/seed/p1-0/800/1000');
    expect(picsumFor('https://loremflickr.com/g/320/240/van', 'x')).toBe('https://picsum.photos/seed/x/320/240');
    expect(picsumFor('https://loremflickr.com/odd', 'x')).toBe('https://picsum.photos/seed/x/800/1000');
  });
});

describe('replaceLoremflickr', () => {
  it('rewrites only loremflickr URLs, stably per product, and only with --apply', async () => {
    const product = await prisma.product.findFirstOrThrow();
    const category = await prisma.category.findFirstOrThrow();
    const lorem = await prisma.productImage.create({
      data: { productId: product.id, url: 'https://loremflickr.com/600/750/shirt?lock=3', sortOrder: 7 },
    });
    const picsum = await prisma.productImage.create({
      data: { productId: product.id, url: 'https://picsum.photos/seed/kept/600/750', sortOrder: 8 },
    });
    await prisma.category.update({ where: { id: category.id }, data: { imageUrl: 'https://loremflickr.com/400/400/fashion' } });

    const dry = await replaceLoremflickr(false);
    expect(dry.found).toBe(2);
    expect(dry.written).toBe(0);
    expect((await prisma.productImage.findUniqueOrThrow({ where: { id: lorem.id } })).url).toContain('loremflickr');

    const done = await replaceLoremflickr(true);
    expect(done.written).toBe(2);
    expect((await prisma.productImage.findUniqueOrThrow({ where: { id: lorem.id } })).url).toBe(
      `https://picsum.photos/seed/${product.id}-7/600/750`,
    );
    expect((await prisma.productImage.findUniqueOrThrow({ where: { id: picsum.id } })).url).toBe('https://picsum.photos/seed/kept/600/750');
    expect((await prisma.category.findUniqueOrThrow({ where: { id: category.id } })).imageUrl).toBe(
      `https://picsum.photos/seed/category-${category.id}/400/400`,
    );

    expect((await replaceLoremflickr(true)).found).toBe(0);
  });
});
