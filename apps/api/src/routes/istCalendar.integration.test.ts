import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SellerPayoutOverview } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * Months and days by the Indian calendar, on a server that runs on UTC (the
 * suite does: test/env.ts). An order delivered at 00:30 on the 1st in India
 * is 19:00 UTC on the last day of the month before; it belongs to the 1st.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
const PRICE = 100_000;

beforeAll(async () => {
  await seedFixture(prisma);
  categoryId = (await prisma.category.findFirstOrThrow({ where: { isActive: true } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function get(path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return res;
}

async function seller() {
  const user = await prisma.user.create({
    data: { phone: '9180000001', name: 'IST Seller', role: Role.SELLER, referralCode: 'IST-S' },
  });
  const profile = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'IST Shop', status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  const product = await prisma.product.create({
    data: {
      sellerId: profile.id,
      categoryId,
      title: 'IST product',
      slug: 'ist-product',
      description: 'Indian calendar test listing.',
      basePricePaise: PRICE,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: 'IST-SKU', pricePaise: PRICE, stock: 9 },
  });
  const shopper = await prisma.user.create({ data: { phone: '9180000002', name: 'IST Shopper', referralCode: 'IST-U' } });
  return { sellerId: profile.id, product, variant, shopperId: shopper.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

let n = 0;
async function deliveredAt(s: Awaited<ReturnType<typeof seller>>, at: string) {
  n += 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: `CLW-IST-${n}`, userId: s.shopperId, shipName: 'S', shipPhone: '9180000003', shipLine1: '1 Lane',
      shipCity: 'City', shipState: 'Maharashtra', shipPincode: '400001', status: 'DELIVERED', subtotalPaise: PRICE, totalPaise: PRICE, paymentMethod: 'UPI',
    },
  });
  await prisma.orderItem.create({
    data: {
      orderId: order.id, productId: s.product.id, variantId: s.variant.id, sellerId: s.sellerId, title: 'ist',
      size: '', color: '', pricePaise: PRICE, quantity: 1, status: 'DELIVERED', shippedAt: new Date(at), deliveredAt: new Date(at),
    },
  });
}

describe('the payouts page on a UTC server', () => {
  it('puts a delivery at 00:30 on 1 Sep (India) in September, not August', async () => {
    expect(new Date(2025, 8, 1).getTimezoneOffset()).toBe(0); // the suite really is on UTC
    const s = await seller();
    await deliveredAt(s, '2025-08-31T18:00:00Z'); // 31 Aug, 23:30 IST
    await deliveredAt(s, '2025-08-31T19:00:00Z'); // 1 Sep, 00:30 IST

    const month = async (m: string) =>
      ((await (await get(`/api/seller/payouts/overview?month=${m}`, s.token)).json()) as { data: SellerPayoutOverview })
        .data;
    const august = await month('2025-08');
    const september = await month('2025-09');
    expect(august.kpis.monthGrossPaise).toBe(PRICE);
    expect(september.kpis.monthGrossPaise).toBe(PRICE);
    // September's daily series starts on the 1st, and the delivery is in it.
    expect(september.trend[0]).toMatchObject({ date: '2025-09-01', grossPaise: PRICE });
    expect(september.trend).toHaveLength(30);
    // A finished month is compared with the whole of the one before.
    expect(september.period).toEqual({
      from: '2025-08-31T18:30:00.000Z',
      to: '2025-09-30T18:30:00.000Z',
      previousFrom: '2025-07-31T18:30:00.000Z',
      previousTo: '2025-08-31T18:30:00.000Z',
    });
  });

  it('dates the TDS report by the Indian calendar', async () => {
    const s = await prisma.sellerProfile.findFirstOrThrow({ where: { shopName: 'IST Shop' } });
    await prisma.payout.create({
      data: {
        sellerId: s.id, reference: 'PAY-IST-1', status: 'PAID', grossPaise: PRICE, netPaise: PRICE,
        periodFrom: new Date('2026-08-31T19:00:00Z'), // 1 Sep, 00:30 IST
        periodTo: new Date('2026-09-30T19:00:00Z'), // 1 Oct, 00:30 IST
      },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: s.userId } });
    const csv = await (await get('/api/seller/payouts/tds-report', signAccessToken({ sub: user.id, role: 'SELLER' }))).text();
    const line = csv.split('\n').find((l) => l.includes('PAY-IST-1'))!;
    expect(line).toContain('2026-09-01');
    expect(line).toContain('2026-10-01');
  });
});
