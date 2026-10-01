import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttributeDef } from '@clowe/shared';
import { seedFixture } from '../test/fixture';
import { DEMO_PRODUCT_MARKER, demoAttributesFor, seedDemoAttributes } from '../../prisma/seed/demoAttributes';

/**
 * Demo spec sheets. What these pin: a demo product with no rows gets one
 * row per field its category rule declares, a select field drawn from its
 * options; the rows are a pure function of the slug, so the backfill and a
 * re-seed agree; a seller's own listing is never touched even when empty,
 * nor is a demo product that already has rows; and a second run fills 0.
 */

const prisma = new PrismaClient();
let sellerId: string;
let categoryId: string;
let seq = 0;

const FASHION_LIKE_SPEC: AttributeDef[] = [
  { key: 'fabric', label: 'Fabric', type: 'text', required: true },
  { key: 'fit', label: 'Fit', type: 'select', options: ['Slim', 'Regular', 'Relaxed'] },
  { key: 'wash_care', label: 'Wash care', type: 'text' },
  { key: 'country_of_origin', label: 'Country of origin', type: 'text', required: true },
];

beforeAll(async () => {
  await seedFixture(prisma);
  // The fixture has no Fashion tree; the pools are keyed by root slug, so
  // the Electronics root is renamed for the duration of this file.
  await prisma.category.update({
    where: { slug: 'electronics' },
    data: { slug: 'fashion', attributeSchema: FASHION_LIKE_SPEC },
  });
  categoryId = (await prisma.category.findUniqueOrThrow({ where: { slug: 'electronics-smartphones' } })).id;
  const user = await prisma.user.create({
    data: { phone: '9800000002', name: 'Demo Attr Seller', role: Role.SELLER, referralCode: 'DMA-S-1' },
  });
  sellerId = (
    await prisma.sellerProfile.create({
      data: { userId: user.id, shopName: 'Demo Attr Shop', status: SellerStatus.APPROVED, approvedAt: new Date() },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function product(description: string, attributes?: object) {
  seq += 1;
  return prisma.product.create({
    data: {
      sellerId,
      categoryId,
      title: `Demo Attr Product ${seq}`,
      slug: `demo-attr-product-${seq}`,
      brand: 'Zephyr',
      description,
      basePricePaise: 100_000,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
      ...(attributes ? { attributes } : {}),
    },
  });
}

describe('demo spec sheets', () => {
  it('fill only demo products with no rows, one row per declared field, and are stable', async () => {
    const demo = await product(`A tee. ${DEMO_PRODUCT_MARKER} — imagery is stock.`);
    const demoEdited = await product(`A tee. ${DEMO_PRODUCT_MARKER}.`, [{ key: 'fabric', label: 'Fabric', value: 'Silk' }]);
    const sellersOwn = await product('A real listing a seller wrote, with the sheet still empty.');

    const first = await seedDemoAttributes(prisma);
    expect(first.filled).toBeGreaterThanOrEqual(1);

    const rows = (await prisma.product.findUniqueOrThrow({ where: { id: demo.id } })).attributes as {
      key: string;
      label: string;
      value: string;
    }[];
    expect(rows.map((r) => r.key)).toEqual(['fabric', 'fit', 'wash_care', 'country_of_origin']);
    expect(rows.map((r) => r.label)).toEqual(['Fabric', 'Fit', 'Wash care', 'Country of origin']);
    for (const r of rows) expect(r.value.length).toBeGreaterThan(0);
    expect(['Slim', 'Regular', 'Relaxed']).toContain(rows[1].value);

    // What a fresh seed would write for the same slug.
    expect(rows).toEqual(
      demoAttributesFor(
        { slug: demo.slug, title: demo.title, brand: 'Zephyr', categorySlug: 'electronics-smartphones', rootSlug: 'fashion' },
        FASHION_LIKE_SPEC,
      ),
    );

    expect((await prisma.product.findUniqueOrThrow({ where: { id: demoEdited.id } })).attributes).toEqual([
      { key: 'fabric', label: 'Fabric', value: 'Silk' },
    ]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: sellersOwn.id } })).attributes).toBeNull();

    const second = await seedDemoAttributes(prisma);
    expect(second.filled).toBe(0);
  });

  it('take the value the title already states over the draw', () => {
    const defs: AttributeDef[] = [
      { key: 'fit', label: 'Fit', type: 'select', options: ['Slim', 'Regular', 'Relaxed', 'Oversized'] },
      { key: 'pattern', label: 'Pattern', type: 'text' },
      { key: 'sleeve', label: 'Sleeve length', type: 'text' },
    ];
    const ref = { brand: null, categorySlug: 'fashion-men', rootSlug: 'fashion' };
    const rows = demoAttributesFor({ ...ref, slug: 'striped-half-sleeve-tee', title: 'Striped Half Sleeve Tee' }, defs);
    expect(rows.map((r) => r.value).slice(1)).toEqual(['Striped', 'Half sleeve']);
    const slim = demoAttributesFor({ ...ref, slug: 'slim-fit-jeans', title: 'Slim Fit Stretch Jeans' }, defs);
    expect(slim[0].value).toBe('Slim');
    // Jeans have no sleeves, whatever the department declares.
    expect(slim.map((r) => r.key)).toEqual(['fit', 'pattern']);
  });

  it('skip a field that makes no sense for the subcategory rather than invent it', () => {
    const rows = demoAttributesFor(
      { slug: 'x-runner', title: 'X Runner', brand: null, categorySlug: 'fashion-footwear', rootSlug: 'fashion' },
      [
        { key: 'fabric', label: 'Fabric', type: 'text' },
        { key: 'sleeve', label: 'Sleeve length', type: 'text' },
      ],
    );
    expect(rows.map((r) => r.key)).toEqual(['fabric']);
    expect(['Synthetic leather', 'Mesh', 'Canvas', 'Genuine leather', 'Knit upper']).toContain(rows[0].value);
  });
});
