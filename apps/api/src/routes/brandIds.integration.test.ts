import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFixture } from '../test/fixture';
import { backfillBrandIds } from '../../prisma/seed/brandIds';

/**
 * Brand ids and the facet indexes. What these pin: a product naming an
 * existing brand in any case is linked to that brand rather than a
 * duplicate; a name no brand has gets one row, shared by every product
 * using it; a second run has nothing to link; and the migration that ships
 * with this leaves GIN indexes on the two JSON columns the facets read.
 */

const prisma = new PrismaClient();
let sellerId: string;
let categoryId: string;
let seq = 0;

beforeAll(async () => {
  await seedFixture(prisma);
  const user = await prisma.user.create({
    data: { phone: '9800000001', name: 'Brand Seller', role: Role.SELLER, referralCode: 'BRD-S-1' },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'Brand Shop', status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  sellerId = seller.id;
  categoryId = (await prisma.category.findUniqueOrThrow({ where: { slug: 'electronics' } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function product(brand: string) {
  seq += 1;
  return prisma.product.create({
    data: {
      sellerId,
      categoryId,
      title: `Brand Product ${seq}`,
      slug: `brand-product-${seq}`,
      description: 'Carries brand text but no brand id.',
      brand,
      basePricePaise: 100_000,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
    },
  });
}

describe('brand id backfill', () => {
  it('links to the existing brand on a case-insensitive name, and creates one row per unknown name', async () => {
    const zephyr = await prisma.brand.findUniqueOrThrow({ where: { slug: 'zephyr' } });
    const brandsBefore = await prisma.brand.count();
    const lower = await product('zephyr');
    const upper = await product('ZEPHYR');
    const newA = await product('Rangreza');
    const newB = await product('Rangreza');

    const report = await backfillBrandIds(prisma);
    expect(report.created).toBe(1);
    expect(report.productsLinked).toBeGreaterThanOrEqual(4);

    const linked = await prisma.product.findMany({
      where: { id: { in: [lower.id, upper.id, newA.id, newB.id] } },
      select: { id: true, brandId: true },
    });
    const byId = new Map(linked.map((p) => [p.id, p.brandId]));
    expect(byId.get(lower.id)).toBe(zephyr.id);
    expect(byId.get(upper.id)).toBe(zephyr.id);
    expect(byId.get(newA.id)).not.toBeNull();
    expect(byId.get(newA.id)).toBe(byId.get(newB.id));

    const rangreza = await prisma.brand.findUniqueOrThrow({ where: { slug: 'rangreza' } });
    expect(rangreza.name).toBe('Rangreza');
    expect(await prisma.brand.count()).toBe(brandsBefore + 1);

    const again = await backfillBrandIds(prisma);
    expect(again.productsLinked).toBe(0);
    expect(again.created).toBe(0);
  });
});

describe('facet indexes', () => {
  it('leaves GIN indexes on product_variants.optionValues and products.attributes', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('product_variants_optionValues_idx', 'products_attributes_idx')
      ORDER BY indexname
    `;
    expect(rows.map((r) => r.indexname)).toEqual(['product_variants_optionValues_idx', 'products_attributes_idx']);
    for (const r of rows) expect(r.indexdef).toMatch(/USING gin .* jsonb_path_ops/);
  });
});
