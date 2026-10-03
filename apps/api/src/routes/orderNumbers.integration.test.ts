import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { generateOrderNumber } from '../services/orderService';

/**
 * New orders get a longer, random order number. Orders placed before keep
 * theirs, and both kinds work in tracking, admin search and the invoice.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let sellerToken: string;
const PHONE = '9195000001';
const OLD_NUMBER = 'CLW-2025-123456';
let newNumber: string;
const orderIds: Record<string, string> = {};

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
  const sellerUser = await prisma.user.create({ data: { phone: '9195000002', name: 'Number Seller', role: Role.SELLER, referralCode: 'ONUM-S' } });
  const seller = await prisma.sellerProfile.create({
    data: { userId: sellerUser.id, shopName: 'Number Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), state: 'Maharashtra' },
  });
  sellerToken = signAccessToken({ sub: sellerUser.id, role: 'SELLER' });
  const admin = await prisma.user.create({ data: { phone: '9195000003', name: 'Number Admin', role: Role.ADMIN, referralCode: 'ONUM-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id, categoryId: category.id, title: 'Numbered Mug', slug: 'numbered-mug', description: 'Order number test.',
      basePricePaise: 50_000, status: ProductStatus.APPROVED,
    },
  });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, sku: 'ONUM-1', pricePaise: 50_000, stock: 5 } });
  const buyer = await prisma.user.create({ data: { phone: PHONE, name: 'Number Buyer', referralCode: 'ONUM-U' } });

  newNumber = await generateOrderNumber();
  for (const orderNumber of [OLD_NUMBER, newNumber]) {
    const order = await prisma.order.create({
      data: {
        orderNumber, userId: buyer.id, shipName: 'Number Buyer', shipPhone: PHONE, shipLine1: '1 Lane', shipCity: 'Pune',
        shipState: 'Maharashtra', shipPincode: '411001', status: 'CONFIRMED', subtotalPaise: 50_000, totalPaise: 50_000, paymentMethod: 'UPI',
        payment: { create: { provider: 'mock', amountPaise: 50_000, status: 'PAID' } },
        items: {
          create: {
            productId: product.id, variantId: variant.id, sellerId: seller.id, title: 'Numbered Mug', size: '', color: '',
            pricePaise: 50_000, quantity: 1, status: 'CONFIRMED', gstRatePercent: 18,
          },
        },
      },
    });
    orderIds[orderNumber] = order.id;
  }
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function get<T>(path: string, token?: string) {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: (await res.json()) as { data: T } };
}

describe('order numbers', () => {
  it('gives a new order CLW- and 10 random characters with no look-alikes, not in sequence', async () => {
    const made = [newNumber];
    for (let i = 0; i < 30; i++) made.push(await generateOrderNumber());
    for (const n of made) expect(n).toMatch(/^CLW-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{10}$/);
    expect(new Set(made).size).toBe(made.length);
  });

  it('tracks old and new numbers, typed in any letter case', async () => {
    for (const orderNumber of [OLD_NUMBER, newNumber]) {
      for (const typed of [orderNumber, orderNumber.toLowerCase()]) {
        const res = await get<{ orderNumber: string }>(`/api/track?orderNumber=${encodeURIComponent(typed)}&phone=${PHONE}`);
        expect(res.status).toBe(200);
        expect(res.json.data.orderNumber).toBe(orderNumber);
      }
    }
  });

  it('finds old and new numbers in admin search, whole or in part', async () => {
    for (const orderNumber of [OLD_NUMBER, newNumber]) {
      for (const q of [orderNumber, orderNumber.slice(-5).toLowerCase()]) {
        const res = await get<{ rows: { orderNumber: string }[] }>(`/api/admin/orders?q=${encodeURIComponent(q)}`, adminToken);
        expect(res.status).toBe(200);
        expect(res.json.data.rows.map((r) => r.orderNumber)).toContain(orderNumber);
      }
    }
  });

  it('prints old and new numbers on the seller invoice', async () => {
    for (const orderNumber of [OLD_NUMBER, newNumber]) {
      const res = await get<{ invoiceNumber: string }>(`/api/seller/orders/${orderIds[orderNumber]}/invoice`, sellerToken);
      expect(res.status).toBe(200);
      expect(res.json.data.invoiceNumber).toContain(orderNumber);
    }
  });
});
