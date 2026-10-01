import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttributeDef } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { backfillAttributeKeys } from '../../prisma/seed/attributeKeys';

/**
 * The spec sheet is stored in one shape, { key, label, value }, whatever a
 * client sends. What these pin: a save with legacy { name, value } rows lands
 * canonical; a required field is satisfied under its label however it is
 * spelt; the public product page reads legacy rows back canonical without a
 * rewrite; and the backfill rewrites stored legacy rows exactly once.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
let seq = 0;

/** Declared on the Electronics root; the product sits in a child, so these are inherited. */
const ELECTRONICS_SPEC: AttributeDef[] = [
  { key: 'model_number', label: 'Model number', type: 'text' },
  { key: 'warranty', label: 'Warranty', type: 'text', required: true },
];

beforeAll(async () => {
  await seedFixture(prisma);
  await prisma.category.update({
    where: { slug: 'electronics' },
    data: { attributeSchema: ELECTRONICS_SPEC },
  });
  const child = await prisma.category.findUniqueOrThrow({ where: { slug: 'electronics-smartphones' } });
  categoryId = child.id;
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
      phone: `96000${String(seq).padStart(5, '0')}`,
      name: `Attr Seller ${seq}`,
      role: Role.SELLER,
      referralCode: `ATR-S-${seq}`,
    },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Attr Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  return { id: seller.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean; data?: any; error?: { code: string } } };
}

/** A complete listing; attributes and mode are what each test varies. */
function listing(overrides: Record<string, unknown>) {
  return {
    title: 'Attr Test Phone',
    categoryId,
    description: 'A phone that exists to test the spec sheet.',
    imageUrls: ['https://example.com/phone.jpg'],
    packingVideoUrl: 'https://example.com/packing.mp4',
    variants: [{ optionValues: {}, pricePaise: 1_000_000, stock: 5 }],
    ...overrides,
  };
}

describe('spec-sheet rows are stored canonical', () => {
  it('turns { name, value } rows into { key, label, value }, keying rule fields from the rule', async () => {
    const s = await makeSeller();
    const { status, body } = await call('POST', '/api/seller/products', s.token, listing({
      mode: 'DRAFT',
      attributes: [
        { name: 'Warranty', value: '1 year' },
        { name: 'Power output', value: '250 W' },
      ],
    }));
    expect(status).toBe(200);

    const stored = await prisma.product.findUniqueOrThrow({ where: { id: body.data.id }, select: { attributes: true } });
    expect(stored.attributes).toEqual([
      { key: 'warranty', label: 'Warranty', value: '1 year' },
      { key: 'power_output', label: 'Power output', value: '250 W' },
    ]);

    const detail = await call('GET', `/api/seller/products/${body.data.id}`, s.token);
    expect(detail.body.data.attributes).toEqual(stored.attributes);
  });

  it('accepts a required field given under its label, whatever the spelling', async () => {
    const s = await makeSeller();
    const { status, body } = await call('POST', '/api/seller/products', s.token, listing({
      mode: 'SUBMIT',
      attributes: [{ name: 'warranty', value: '2 years' }],
    }));
    expect(status).toBe(200);
    expect(body.data.status).toBe('PENDING');
  });

  it('still refuses a submission that leaves a required field empty', async () => {
    const s = await makeSeller();
    const { status, body } = await call('POST', '/api/seller/products', s.token, listing({
      mode: 'SUBMIT',
      attributes: [{ name: 'Model number', value: 'AT-1' }],
    }));
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ATTRIBUTES_REQUIRED');
  });
});

describe('rows stored before keys existed', () => {
  async function legacyProduct() {
    const s = await makeSeller();
    seq += 1;
    return prisma.product.create({
      data: {
        sellerId: s.id,
        categoryId,
        title: `Legacy Phone ${seq}`,
        slug: `legacy-phone-${seq}`,
        description: 'Stored with the pre-canonical attribute shape.',
        basePricePaise: 1_000_000,
        status: ProductStatus.APPROVED,
        approvedAt: new Date(),
        attributes: [
          { name: 'Warranty', value: '3 years' },
          { name: 'Power output', value: '250 W' },
        ],
      },
    });
  }

  it('read back canonical on the product page', async () => {
    const product = await legacyProduct();
    const { status, body } = await call('GET', `/api/products/${product.slug}`, null);
    expect(status).toBe(200);
    expect(body.data.attributes).toEqual([
      { key: 'warranty', label: 'Warranty', value: '3 years' },
      { key: 'power_output', label: 'Power output', value: '250 W' },
    ]);
  });

  it('are rewritten by the backfill once, and left alone the second time', async () => {
    const product = await legacyProduct();
    const first = await backfillAttributeKeys(prisma);
    expect(first.productsChanged).toBeGreaterThanOrEqual(1);

    const stored = await prisma.product.findUniqueOrThrow({ where: { id: product.id }, select: { attributes: true } });
    expect(stored.attributes).toEqual([
      { key: 'warranty', label: 'Warranty', value: '3 years' },
      { key: 'power_output', label: 'Power output', value: '250 W' },
    ]);

    const second = await backfillAttributeKeys(prisma);
    expect(second.productsChanged).toBe(0);
  });
});
