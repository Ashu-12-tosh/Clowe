import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { applyRevision } from '../services/productRevisions';
import { signAccessToken } from '../utils/jwt';
import { TEST_SELLER_ADDRESS } from '../test/fixture';

/**
 * Removing a variant in the product form. One that was never ordered is
 * deleted; one that was cannot be (its order line points at it), and used to
 * fail the whole save with a foreign-key error, so the seller's X did nothing.
 * Now it is retired: gone from the form, the storefront and every cart, kept
 * for its order.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;
let productId: string;
let slug: string;
const ids: Record<'S' | 'M' | 'L', string> = { S: '', M: '', L: '' };
let orderId: string;
let shopperId: string;

async function save(variants: Array<Record<string, unknown>>) {
  const res = await fetch(`${base}/api/seller/products/${productId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Removal Test Tee',
      categoryId: (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).categoryId,
      description: 'A tee that exists to test removing variants.',
      imageUrls: ['https://example.com/tee.jpg'],
      variants,
      mode: 'DRAFT',
    }),
  });
  return { status: res.status, body: await res.text() };
}

const keep = (id: string, size: string) => ({ id, optionValues: { size }, sellerPricePaise: 50_000, stock: 5 });

beforeAll(async () => {
  const sellerUser = await prisma.user.create({
    data: { phone: '9198800001', name: 'Removal Seller', role: Role.SELLER, referralCode: 'RMV-S' },
  });
  const seller = await prisma.sellerProfile.create({
    data: { ...TEST_SELLER_ADDRESS, userId: sellerUser.id, shopName: 'Removal Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5' },
  });
  token = signAccessToken({ sub: sellerUser.id, role: 'SELLER' });
  const category = await prisma.category.create({ data: { name: 'Removal Tees', slug: 'removal-tees', isActive: true } });
  slug = 'removal-test-tee';
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      categoryId: category.id,
      title: 'Removal Test Tee',
      slug,
      description: 'A tee that exists to test removing variants.',
      basePricePaise: 59_000,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
      images: { create: [{ url: 'https://example.com/tee.jpg', sortOrder: 0 }] },
    },
  });
  productId = product.id;
  for (const size of ['S', 'M', 'L'] as const) {
    const v = await prisma.productVariant.create({
      data: {
        productId,
        optionValues: { size },
        optionsKey: `size=${size}`,
        label: size,
        size,
        sku: `RMV-${size}`,
        pricePaise: 59_000,
        sellerPricePaise: 50_000,
        stock: 5,
      },
    });
    ids[size] = v.id;
  }
  // S has been ordered, and sits in someone's cart.
  const shopper = await prisma.user.create({ data: { phone: '9198800002', name: 'Removal Shopper', referralCode: 'RMV-C' } });
  shopperId = shopper.id;
  const order = await prisma.order.create({
    data: {
      userId: shopper.id,
      orderNumber: 'CLW-2026-880001',
      status: 'PLACED',
      subtotalPaise: 59_000,
      shippingPaise: 0,
      totalPaise: 59_000,
      shipName: 'Removal Shopper',
      shipPhone: '9198800002',
      shipLine1: '1 Test Street',
      shipCity: 'Pune',
      shipState: 'Maharashtra',
      shipPincode: '411001',
      items: {
        create: [{
          productId, variantId: ids.S, sellerId: seller.id, title: 'Removal Test Tee',
          size: 'S', color: '', variantLabel: 'S', pricePaise: 59_000, quantity: 1,
        }],
      },
    },
  });
  orderId = order.id;
  await prisma.cart.create({ data: { userId: shopper.id, items: { create: [{ variantId: ids.S, quantity: 1 }] } } });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // Fixture resets clear users before orders; take away the order this file made.
  await prisma.order.deleteMany({ where: { id: orderId } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('removing variants from a live listing', () => {
  it('saves: the ordered one is retired, the other deleted', async () => {
    const r = await save([keep(ids.L, 'L')]);
    expect(r.status, r.body).toBe(200);

    const s = await prisma.productVariant.findUniqueOrThrow({ where: { id: ids.S } });
    expect(s.retiredAt).not.toBeNull();
    expect(s.stock).toBe(0);
    expect(s.optionsKey).toBe(`retired:${ids.S}`);
    expect(await prisma.productVariant.findUnique({ where: { id: ids.M } })).toBeNull();
    expect(await prisma.orderItem.count({ where: { orderId, variantId: ids.S } })).toBe(1);
  });

  it('takes the retired one out of every cart', async () => {
    expect(await prisma.cartItem.count({ where: { cart: { userId: shopperId } } })).toBe(0);
  });

  it('shows neither in the seller form nor on the product page', async () => {
    const mine = await fetch(`${base}/api/seller/products/${productId}`, { headers: { authorization: `Bearer ${token}` } });
    const detail = ((await mine.json()) as { data: { variants: Array<{ id: string }> } }).data;
    expect(detail.variants.map((v) => v.id)).toEqual([ids.L]);

    const pub = await fetch(`${base}/api/products/${slug}`);
    expect(pub.status).toBe(200);
    const page = ((await pub.json()) as { data: { variants: Array<{ id: string }> } }).data;
    expect(page.variants.map((v) => v.id)).toEqual([ids.L]);
  });

  it('cannot be added to a cart any more', async () => {
    const shopperToken = signAccessToken({ sub: shopperId, role: 'CUSTOMER' });
    const res = await fetch(`${base}/api/cart/items`, {
      method: 'POST',
      headers: { authorization: `Bearer ${shopperToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ variantId: ids.S, quantity: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it('lets the same size be added again as a new variant', async () => {
    // On a live listing a new variant waits for review, then goes live.
    const r = await save([keep(ids.L, 'L'), { optionValues: { size: 'S' }, sellerPricePaise: 50_000, stock: 3 }]);
    expect(r.status, r.body).toBe(200);
    await prisma.productRevision.update({ where: { productId }, data: { status: 'PENDING' } });
    await applyRevision(productId);
    const live = await prisma.productVariant.findMany({ where: { productId, retiredAt: null }, orderBy: { size: 'asc' } });
    expect(live.map((v) => v.size)).toEqual(['L', 'S']);
    expect(live.find((v) => v.size === 'S')!.id).not.toBe(ids.S);
  });
});
