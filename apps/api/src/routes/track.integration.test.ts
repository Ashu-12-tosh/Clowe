import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * Public order tracking shows status, dates and the courier's name. The
 * courier's tracking number and link are for the signed-in buyer only, and
 * public lookups have their own limit.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let orderNumber: string;
let orderId: string;
let buyerToken: string;
const PHONE = '9193000001';
const AWB = 'DLV7788990011';
const LINK = 'https://courier.example/track/DLV7788990011';
/** Every request this file makes to /api/track, for the limit test. */
let lookups = 0;

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
  const sellerUser = await prisma.user.create({ data: { phone: '9193000002', name: 'Track Seller', role: Role.SELLER, referralCode: 'TRACK-S' } });
  const seller = await prisma.sellerProfile.create({ data: { userId: sellerUser.id, shopName: 'Track Shop', status: SellerStatus.APPROVED } });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id, categoryId: category.id, title: 'Tracked Kettle', slug: 'tracked-kettle', description: 'Tracking test.',
      basePricePaise: 100_000, status: ProductStatus.APPROVED,
    },
  });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, sku: 'TRACK-1', pricePaise: 100_000, stock: 5 } });
  const buyer = await prisma.user.create({ data: { phone: PHONE, name: 'Track Buyer', referralCode: 'TRACK-U' } });
  buyerToken = signAccessToken({ sub: buyer.id, role: 'CUSTOMER' });
  const order = await prisma.order.create({
    data: {
      orderNumber: 'CLW-2026-424242', userId: buyer.id, shipName: 'Track Buyer', shipPhone: PHONE, shipLine1: '12 Hidden Street',
      shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001', status: 'SHIPPED', subtotalPaise: 100_000, totalPaise: 100_000,
      paymentMethod: 'UPI',
      items: {
        create: {
          productId: product.id, variantId: variant.id, sellerId: seller.id, title: 'Tracked Kettle', size: '', color: '',
          pricePaise: 100_000, quantity: 1, status: 'SHIPPED', shippedAt: new Date(), courierName: 'Delhivery', awbNumber: AWB, trackingUrl: LINK,
        },
      },
    },
  });
  orderNumber = order.orderNumber;
  orderId = order.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function track(phone: string) {
  lookups += 1;
  const res = await fetch(`${base}/api/track?orderNumber=${encodeURIComponent(orderNumber)}&phone=${phone}`);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { data?: { items: Record<string, unknown>[] }; error?: { code: string } } };
}

describe('public order tracking', () => {
  it('shows status and the courier, never its tracking number or link, nor the street', async () => {
    const res = await track(PHONE);
    expect(res.status).toBe(200);
    const item = res.json.data!.items[0];
    expect(item).toMatchObject({ status: 'SHIPPED', courierName: 'Delhivery' });
    expect(item).not.toHaveProperty('awbNumber');
    expect(item).not.toHaveProperty('trackingUrl');
    expect(res.text).not.toContain(AWB);
    expect(res.text).not.toContain(LINK);
    expect(res.text).not.toContain('Hidden Street');
  });

  it('still refuses a phone that is not on the order', async () => {
    const res = await track('9193000999');
    expect(res.status).toBe(404);
  });

  it('keeps the full courier detail on the signed-in buyer’s own order page', async () => {
    const res = await fetch(`${base}/api/orders/${orderId}`, { headers: { authorization: `Bearer ${buyerToken}` } });
    const json = (await res.json()) as { data: { items: { awbNumber: string | null; trackingUrl: string | null; courierName: string | null }[] } };
    expect(json.data.items[0]).toMatchObject({ courierName: 'Delhivery', awbNumber: AWB, trackingUrl: LINK });
  });

  it('allows 10 lookups per 15 minutes from one address, then refuses', async () => {
    while (lookups < 10) expect((await track(PHONE)).status).toBe(200);
    const refused = await track(PHONE);
    expect(refused.status).toBe(429);
    expect(refused.json.error?.code).toBe('TOO_MANY_REQUESTS');
  });
});
