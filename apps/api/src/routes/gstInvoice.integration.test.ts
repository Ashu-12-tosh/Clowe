import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SellerInvoice } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { invalidateCategoryRules } from '../services/categoryRules';
import { signAccessToken } from '../utils/jwt';

/**
 * The tax invoice asks gstRateFor, the same function the seller's pricing
 * breakdown uses, with the product's category rule. Two apparel pieces either
 * side of the ₹2,500 value slab must come out at different rates on one
 * invoice — the old code took the rate of the first line for the whole order,
 * and a listing-level choice before the category.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

let sellerToken: string;
let orderId: string;

beforeAll(async () => {
  await seedFixture(prisma);
  const apparel = await prisma.category.create({
    data: { name: 'GST Apparel', slug: 'gst-test-apparel', taxRule: 'VALUE_SLAB', hsnCode: '6109' },
  });
  const jewellery = await prisma.category.create({
    data: { name: 'GST Jewellery', slug: 'gst-test-jewellery', defaultTaxRatePercent: 3, hsnCode: '7117' },
  });
  invalidateCategoryRules();

  const user = await prisma.user.create({
    data: { phone: '9300000001', name: 'GST Seller', role: Role.SELLER, referralCode: 'GST-S-1' },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'GST Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), state: 'Maharashtra' },
  });
  sellerToken = signAccessToken({ sub: user.id, role: 'SELLER' });
  const shopper = await prisma.user.create({
    data: { phone: '9300000002', name: 'GST Shopper', referralCode: 'GST-U-1' },
  });

  const lines: { categoryId: string; pricePaise: number; slug: string }[] = [
    { categoryId: apparel.id, pricePaise: 262_500, slug: 'gst-shirt-2625' },
    { categoryId: apparel.id, pricePaise: 299_000, slug: 'gst-shirt-2990' },
    { categoryId: jewellery.id, pricePaise: 103_000, slug: 'gst-earrings-1030' },
  ];
  const total = lines.reduce((s, l) => s + l.pricePaise, 0);
  const order = await prisma.order.create({
    data: {
      orderNumber: 'CLW-GST-000001',
      userId: shopper.id,
      shipName: 'GST Shopper',
      shipPhone: '9300000002',
      shipLine1: '1 Test Lane',
      shipCity: 'Mumbai',
      shipState: 'Maharashtra',
      shipPincode: '400001',
      status: 'CONFIRMED',
      subtotalPaise: total,
      totalPaise: total,
      paymentMethod: 'UPI',
      payment: { create: { provider: 'mock', amountPaise: total, status: 'PAID' } },
    },
  });
  orderId = order.id;
  for (const l of lines) {
    const product = await prisma.product.create({
      data: {
        sellerId: seller.id,
        categoryId: l.categoryId,
        title: l.slug,
        slug: l.slug,
        description: 'GST invoice regression test.',
        basePricePaise: l.pricePaise,
        status: ProductStatus.APPROVED,
        approvedAt: new Date(),
      },
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        optionValues: { size: 'M' },
        optionsKey: 'size:M',
        label: 'M',
        size: 'M',
        color: '',
        sku: `SKU-${l.slug}`,
        pricePaise: l.pricePaise,
        stock: 5,
      },
    });
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        variantId: variant.id,
        sellerId: seller.id,
        title: l.slug,
        size: 'M',
        color: '',
        pricePaise: l.pricePaise,
        quantity: 1,
        status: 'CONFIRMED',
      },
    });
  }

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the seller tax invoice', () => {
  it('derives each line’s rate from its category and price', async () => {
    const res = await fetch(`${base}/api/seller/orders/${orderId}/invoice`, {
      headers: { authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: SellerInvoice };
    const byTitle = new Map(data.lines.map((l) => [l.title, l]));

    // ₹2,625 inclusive is ₹2,500 ex-GST at 5% — inside the merit slab.
    expect(byTitle.get('gst-shirt-2625')).toMatchObject({ gstRatePercent: 5, taxablePaise: 250_000, gstPaise: 12_500 });
    // ₹2,990 is over it: 18%.
    expect(byTitle.get('gst-shirt-2990')).toMatchObject({ gstRatePercent: 18, taxablePaise: 253_390, gstPaise: 45_610 });
    // A flat category ignores price.
    expect(byTitle.get('gst-earrings-1030')).toMatchObject({ gstRatePercent: 3, taxablePaise: 100_000, gstPaise: 3_000 });
  });
});
