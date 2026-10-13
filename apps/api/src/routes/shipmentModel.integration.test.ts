import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * The shipment data model: a seller's part of an order travels as one
 * Shipment that its lines point at; courier scans are kept once however often
 * they arrive; a line that came back undelivered (RTO) is not a sale; and the
 * new seller and customer fields start empty.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;
let sellerId: string;
let orderId: string;
let deliveredLine: string;
let rtoLine: string;
let buyerId: string;

beforeAll(async () => {
  const user = await prisma.user.create({ data: { phone: '9199400001', name: 'Shipment Seller', role: Role.SELLER, referralCode: 'SHP-S' } });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'Shipment Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5' },
  });
  sellerId = seller.id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  buyerId = (await prisma.user.create({ data: { phone: '9199400002', name: 'Shipment Buyer', referralCode: 'SHP-B' } })).id;
  const category = await prisma.category.create({ data: { name: 'Shipment Things', slug: 'shipment-things', isActive: true } });
  const product = await prisma.product.create({
    data: { sellerId, categoryId: category.id, title: 'Parcel Thing', slug: 'parcel-thing', description: 'For the shipment model tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-SHP', pricePaise: 50_000, stock: 10 } });
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: 'CLW-2026-940001', status: 'SHIPPED', subtotalPaise: 80_000, shippingPaise: 0, totalPaise: 80_000,
      shipName: 'Shipment Buyer', shipPhone: '9199400002', shipLine1: '1 Test Street', shipCity: 'Mumbai', shipState: 'Maharashtra', shipPincode: '400001',
      items: {
        create: [
          { productId: product.id, variantId: variant.id, sellerId, title: 'Parcel Thing', size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'DELIVERED' },
          { productId: product.id, variantId: variant.id, sellerId, title: 'Parcel Thing', size: '', color: '', pricePaise: 30_000, quantity: 1, status: 'RTO_DELIVERED' },
        ],
      },
    },
    include: { items: { orderBy: { pricePaise: 'desc' } } },
  });
  orderId = order.id;
  [deliveredLine, rtoLine] = order.items.map((i) => i.id) as [string, string];
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: orderId } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the shipment model', () => {
  it('holds a seller’s part of an order as one shipment its lines point at', async () => {
    const shipment = await prisma.shipment.create({
      data: {
        orderId, sellerId, provider: 'mock', environment: 'mock', awbNumber: 'MOCK-940001', paymentType: 'PREPAID',
        weightGrams: 500, lengthMm: 200, widthMm: 150, heightMm: 50,
        items: { connect: [{ id: deliveredLine }, { id: rtoLine }] },
      },
      include: { items: true },
    });
    expect(shipment).toMatchObject({ kind: 'FORWARD', status: 'CREATED', mode: 'SURFACE', codAmountPaise: 0 });
    expect(shipment.items.map((i) => i.id).sort()).toEqual([deliveredLine, rtoLine].sort());
  });

  it('keeps each courier scan once, however often it is pushed or polled', async () => {
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId } });
    const scan = { shipmentId: shipment.id, at: new Date('2026-10-20T10:00:00Z'), status: 'In Transit', statusType: 'UD', code: 'X-PPOM', source: 'POLL' };
    await prisma.shipmentEvent.createMany({ data: [scan], skipDuplicates: true });
    await prisma.shipmentEvent.createMany({ data: [{ ...scan, source: 'WEBHOOK' }], skipDuplicates: true });
    expect(await prisma.shipmentEvent.count({ where: { shipmentId: shipment.id } })).toBe(1);
  });

  it('starts sellers with no courier warehouse and customers with no RTOs', async () => {
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller).toMatchObject({ courierWarehouseStatus: 'NONE', courierWarehouseName: null });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })).rtoCount).toBe(0);
  });
});

describe('a line that came back undelivered (RTO)', () => {
  it('is not counted in the seller’s sales', async () => {
    const res = await fetch(`${base}/api/seller/stats`, { headers: { authorization: `Bearer ${token}` } });
    const stats = ((await res.json()) as { data: { totalOrderItems: number; unitsSold: number; revenuePaise: number } }).data;
    expect(stats).toMatchObject({ totalOrderItems: 1, unitsSold: 1, revenuePaise: 50_000 });
  });
});
