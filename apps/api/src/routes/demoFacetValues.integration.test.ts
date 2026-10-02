import { PrismaClient, ProductStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFixture } from '../test/fixture';
import { invalidateCategoryRules } from '../services/categoryRules';
import { seedCategoryFacets } from '../../prisma/seed/facets';
import { facetCoverage, seedDemoFacetValues } from '../../prisma/seed/demoFacetValues';
import { DEMO_PRODUCT_MARKER } from '../../prisma/seed/demoAttributes';

/**
 * The demo catalog's missing facet values: from what a product says about
 * itself first, never over a value it has, never on a seller's listing.
 */

const prisma = new PrismaClient();
let sellerId: string;
let laptopsId: string;
let phonesId: string;

beforeAll(async () => {
  await seedFixture(prisma);
  sellerId = (await prisma.sellerProfile.findFirstOrThrow()).id;
  const electronics = await prisma.category.findUniqueOrThrow({ where: { slug: 'electronics' } });
  laptopsId = (await prisma.category.create({ data: { name: 'Laptops', slug: 'electronics-laptops', parentId: electronics.id } })).id;
  phonesId = (await prisma.category.findUniqueOrThrow({ where: { slug: 'mobiles-smartphones' } })).id;
  await seedCategoryFacets(prisma, true);
  invalidateCategoryRules();
});

afterAll(async () => {
  await prisma.$disconnect();
});

let n = 0;
async function product(categoryId: string, title: string, opts: { demo?: boolean; attributes?: object[]; options?: Record<string, string> } = {}) {
  n += 1;
  const p = await prisma.product.create({
    data: {
      sellerId,
      categoryId,
      title,
      slug: `facet-demo-${n}`,
      description: opts.demo === false ? 'A seller listing.' : `${DEMO_PRODUCT_MARKER}.`,
      basePricePaise: 5_000_000,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
      attributes: opts.attributes ?? [],
    },
  });
  await prisma.productVariant.create({
    data: { productId: p.id, optionValues: opts.options ?? {}, sku: `FD-${n}`, pricePaise: 5_000_000, stock: 3 },
  });
  return p;
}

const attrs = async (id: string) =>
  ((await prisma.product.findUniqueOrThrow({ where: { id } })).attributes as { key: string; value: string }[]) ?? [];
const value = (rows: { key: string; value: string }[], key: string) => rows.find((r) => r.key === key)?.value;

describe('filling the demo catalog', () => {
  it('takes what the title says, and leaves alone what the variants already carry', async () => {
    const laptop = await product(laptopsId, 'Zenlite Air 14 Thin & Light Laptop', { options: { ram: '16GB', storage: '512GB SSD' } });
    await seedDemoFacetValues(prisma, true);
    const rows = await attrs(laptop.id);
    expect(value(rows, 'screen_size')).toBe('14"');
    expect(value(rows, 'processor')).toBe('Intel Core i5');
    // RAM and storage are variant options here: nothing written for them.
    expect(value(rows, 'ram')).toBeUndefined();
    expect(value(rows, 'storage')).toBeUndefined();
  });

  it("reads another field of the product's own spec sheet before drawing", async () => {
    const phone = await product(phonesId, 'Zephyr Note Ultra Smartphone', {
      attributes: [{ key: 'display', label: 'Display', value: '6.7" AMOLED, 120Hz' }],
    });
    await seedDemoFacetValues(prisma, true);
    expect(value(await attrs(phone.id), 'screen_size')).toBe('6.7"');
  });

  it('never overwrites a value, never touches a seller listing, and writes nothing the second time', async () => {
    const kept = await product(laptopsId, 'Raptor 15 Gaming Laptop', {
      attributes: [{ key: 'processor', label: 'Processor', value: 'AMD Ryzen 9' }],
    });
    const sellers = await product(laptopsId, 'Shop Laptop 15', { demo: false });
    await seedDemoFacetValues(prisma, true);
    expect(value(await attrs(kept.id), 'processor')).toBe('AMD Ryzen 9');
    expect(value(await attrs(kept.id), 'screen_size')).toBe('15.6"');
    expect(await attrs(sellers.id)).toEqual([]);
    expect(await seedDemoFacetValues(prisma, true)).toEqual({ products: 0, values: {} });
  });

  it('reports coverage per category, counting spec values and variant options alike', async () => {
    const laptops = (await facetCoverage(prisma)).find((r) => r.slug === 'electronics-laptops')!;
    expect(laptops.products).toBe(3);
    const of = (key: string) => laptops.facets.find((f) => f.key === key)!.withValue;
    expect(of('screen_size')).toBe(2); // the seller's listing has none
    expect(of('ram')).toBe(1); // only the first laptop has RAM variants
  });
});
