import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthToDateIST, type SellerCatalogSummary } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * The seller products page's cards compare like with like: the catalogue
 * against itself at the start of the month, and sales this month so far
 * against the same days of last month, with months by the Indian calendar.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;
let summary: SellerCatalogSummary;
const period = monthToDateIST(new Date());
const minute = 60_000;

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
  const user = await prisma.user.create({ data: { phone: '9130000001', name: 'KPI Seller', role: Role.SELLER, referralCode: 'KPI-S' } });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'KPI Shop', status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  const shopper = await prisma.user.create({ data: { phone: '9130000002', name: 'KPI Shopper', referralCode: 'KPI-U' } });

  // One listing from before the month began, one from this month.
  const made = async (slug: string, createdAt: Date) => {
    const product = await prisma.product.create({
      data: {
        sellerId: seller.id, categoryId: category.id, title: slug, slug, description: 'KPI test listing.',
        basePricePaise: 1_000, status: ProductStatus.APPROVED, approvedAt: createdAt, createdAt,
      },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: `SKU-${slug}`, pricePaise: 1_000, stock: 5 },
    });
    return { product, variant };
  };
  const older = await made('kpi-older', new Date(period.from.getTime() - 24 * 60 * minute));
  await made('kpi-newer', new Date(Math.min(Date.now(), period.from.getTime() + minute)));

  let n = 0;
  const sold = async (pricePaise: number, createdAt: Date) => {
    n += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: `CLW-KPI-${n}`, userId: shopper.id, shipName: 'S', shipPhone: '9130000002', shipLine1: '1 Lane',
        shipCity: 'Mumbai', shipState: 'Maharashtra', shipPincode: '400001', status: 'DELIVERED',
        subtotalPaise: pricePaise, totalPaise: pricePaise, paymentMethod: 'UPI', createdAt,
      },
    });
    await prisma.orderItem.create({
      data: {
        orderId: order.id, productId: older.product.id, variantId: older.variant.id, sellerId: seller.id, title: 'kpi',
        size: '', color: '', pricePaise, quantity: 1, status: 'DELIVERED',
      },
    });
  };
  await sold(100_000, new Date(Math.min(Date.now() - 1, period.from.getTime() + minute))); // this month
  await sold(40_000, new Date(period.previousFrom.getTime() + minute)); // same days, last month
  await sold(7_000, new Date(period.from.getTime() - minute)); // later in last month: not like for like

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/seller/products/summary`, { headers: { authorization: `Bearer ${token}` } });
  summary = ((await res.json()) as { data: SellerCatalogSummary }).data;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the seller products cards', () => {
  it('compare the catalogue with itself at the start of the month', () => {
    expect(summary.kpis).toMatchObject({ total: 2, totalAtMonthStart: 1, totalChangePercent: 100 });
  });

  it('compare sales this month so far with the same days of last month only', () => {
    expect(summary.kpis.salesPaise).toBe(100_000);
    // The order late last month is outside the matching days, unless this
    // month has already run longer than last month did.
    const lastMonthFully = period.previousTo.getTime() === period.from.getTime();
    expect(summary.kpis.salesPreviousPaise).toBe(lastMonthFully ? 47_000 : 40_000);
    expect(summary.kpis.salesLifetimePaise).toBe(147_000);
  });

  it('name the periods, by the Indian calendar', () => {
    expect(summary.period.from).toBe(period.from.toISOString());
    expect(summary.period.previousFrom).toBe(period.previousFrom.toISOString());
    // A month starts at midnight in India: 18:30 UTC the day before.
    expect(summary.period.from.endsWith('T18:30:00.000Z')).toBe(true);
  });
});
