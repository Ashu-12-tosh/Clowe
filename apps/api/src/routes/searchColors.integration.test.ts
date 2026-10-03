import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { invalidateSearchCatalog } from '../services/productSearch';

/**
 * Colours are searchable: a variant's colour name ("Powder Blue") and its
 * colour family ("Blue") reach the search vector through products.searchColors,
 * which a database trigger keeps in step with the variants.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let productId: string;
let slug: string;

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
  const user = await prisma.user.create({ data: { phone: '9190000001', name: 'Colour Seller', role: Role.SELLER, referralCode: 'COLOUR-S' } });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'Colour Shop', status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  slug = 'colour-test-linen-shirt';
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id, categoryId: category.id, title: 'Colour Test Linen Shirt', slug,
      description: 'A shirt whose colours appear nowhere but on its variants.', basePricePaise: 100_000,
      status: ProductStatus.APPROVED, approvedAt: new Date(),
    },
  });
  productId = product.id;
  for (const [i, [color, family]] of [['Powder Blue', 'Blue'], ['Crimson', 'Red']].entries()) {
    await prisma.productVariant.create({
      data: {
        productId, optionValues: { color, color_family: family }, optionsKey: `color=${color}`, label: color, color,
        sku: `COLOUR-${i}`, pricePaise: 100_000, stock: 5,
      },
    });
  }
  invalidateSearchCatalog();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function found(q: string): Promise<boolean> {
  const res = await fetch(`${base}/api/products?q=${encodeURIComponent(q)}&limit=48`);
  const json = (await res.json()) as { data: { items: { slug: string }[] } };
  return json.data.items.some((i) => i.slug === slug);
}

describe('colours in search', () => {
  it('finds a product by a colour name and by its colour family', async () => {
    expect(await found('crimson')).toBe(true);
    expect(await found('powder blue')).toBe(true);
    expect(await found('red')).toBe(true);
    expect(await found('blue')).toBe(true);
    expect(await found('red shirt')).toBe(true);
    // (Not "green shirt": with no exact match anywhere, the typo fallback reads it as "shirt".)
    expect(await found('green')).toBe(false);
  });

  it('follows the variants: a colour edited or removed leaves the index', async () => {
    const crimson = await prisma.productVariant.findFirstOrThrow({ where: { productId, color: 'Crimson' } });
    await prisma.productVariant.update({
      where: { id: crimson.id },
      data: { color: 'Olive', optionValues: { color: 'Olive', color_family: 'Green' }, label: 'Olive' },
    });
    expect(await found('green shirt')).toBe(true);
    expect(await found('crimson')).toBe(false);

    await prisma.productVariant.delete({ where: { id: crimson.id } });
    expect(await found('olive')).toBe(false);
    expect(await found('powder blue')).toBe(true);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).searchColors).toBe('Blue Powder Blue');
  });
});
