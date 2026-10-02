import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SellerProductDetail } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { backfillColorFamilies } from '../../prisma/seed/colorFamilies';

/**
 * optionValues.color_family: written beside the colour on every variant save
 * for the filter rail, invisible everywhere else. What these pin: a save with
 * colour "Powder Blue" stores family "Blue" without changing the variant's
 * identity (optionsKey) or what the seller reads back; and the backfill gives
 * existing variants the same, reports colours it cannot place, and is a
 * no-op the second time.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
let seq = 0;

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findUniqueOrThrow({ where: { slug: 'electronics-smartphones' } });
  categoryId = category.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function makeSeller() {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `97000${String(seq).padStart(5, '0')}`,
      name: `Colour Seller ${seq}`,
      role: Role.SELLER,
      referralCode: `CLR-S-${seq}`,
    },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Colour Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  return { id: seller.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean; data: SellerProductDetail; error?: { code: string } } };
}

describe('colour family on variant write', () => {
  it('stores color_family beside the colour, outside the options key and the read', async () => {
    const s = await makeSeller();
    const { status, body } = await call('POST', '/api/seller/products', s.token, {
      title: 'Colour Test Phone',
      categoryId,
      description: 'A phone that exists to test colour families.',
      imageUrls: ['https://example.com/phone.jpg'],
      mode: 'DRAFT',
      variants: [
        {
          optionValues: { color: 'Powder Blue', storage: '128GB' },
          pricePaise: 1_000_000,
          stock: 5,
          imageUrls: ['https://example.com/phone-blue.jpg'],
        },
      ],
    });
    expect(status).toBe(200);

    const stored = await prisma.productVariant.findFirstOrThrow({ where: { productId: body.data.id } });
    expect(stored.optionValues).toEqual({ color: 'Powder Blue', storage: '128GB', color_family: 'Blue' });
    expect(stored.optionsKey).toBe('color=Powder Blue|storage=128GB');
    expect(stored.label).toBe('Powder Blue · 128GB');

    const detail = await call('GET', `/api/seller/products/${body.data.id}`, s.token);
    expect(detail.body.data.variants[0].optionValues).toEqual({ color: 'Powder Blue', storage: '128GB' });
  });
});

describe('colour family backfill', () => {
  it('fills existing variants, reports what it cannot place, and then has nothing to do', async () => {
    const s = await makeSeller();
    seq += 1;
    const product = await prisma.product.create({
      data: {
        sellerId: s.id,
        categoryId,
        title: `Backfill Phone ${seq}`,
        slug: `backfill-phone-${seq}`,
        description: 'Variants stored before colour families existed.',
        basePricePaise: 1_000_000,
        status: ProductStatus.APPROVED,
        approvedAt: new Date(),
        variants: {
          create: [
            { optionValues: { color: 'Sage Green' }, optionsKey: 'color=Sage Green', label: 'Sage Green', color: 'Sage Green', sku: `SKU-CLR-${seq}-A`, pricePaise: 1_000_000, stock: 1 },
            { optionValues: { color: 'Zebra' }, optionsKey: 'color=Zebra', label: 'Zebra', color: 'Zebra', sku: `SKU-CLR-${seq}-B`, pricePaise: 1_000_000, stock: 1 },
            { optionValues: { storage: '64GB' }, optionsKey: 'storage=64GB', label: '64GB', sku: `SKU-CLR-${seq}-C`, pricePaise: 1_000_000, stock: 1 },
          ],
        },
      },
    });

    const first = await backfillColorFamilies(prisma);
    expect(first.updated).toBeGreaterThanOrEqual(1);
    expect(first.unmatched.get('Zebra')).toBe(1);

    const variants = await prisma.productVariant.findMany({ where: { productId: product.id }, orderBy: { sku: 'asc' } });
    expect(variants.map((v) => v.optionValues)).toEqual([
      { color: 'Sage Green', color_family: 'Green' },
      { color: 'Zebra' },
      { storage: '64GB' },
    ]);

    const second = await backfillColorFamilies(prisma);
    expect(second.updated).toBe(0);
  });
});
