import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { eligibleItems } from '../services/payoutService';
import { settlementPosition } from '../services/sellerLedgerService';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * A COD line is payable to its seller only once Delhivery's remittance for its
 * parcel is matched — besides the return-window hold. An admin imports the
 * remittance report (CSV) and rows match by AWB and amount; a different
 * amount, an AWB we don't know or one already matched releases nothing.
 * Prepaid sales never wait for it.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;
let adminToken: string;
let sellerId: string;
let productId: string;
let variantId: string;
let buyerId: string;
let seq = 0;
const orders: string[] = [];

async function call(method: string, path: string, body?: unknown, auth = token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>; error?: { message: string } } };
}

/** A delivered order of ours: COD or prepaid. */
async function delivered(cod: boolean) {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-33${String(seq).padStart(4, '0')}`, status: 'CONFIRMED', subtotalPaise: 50_000, shippingPaise: 0, totalPaise: 50_000,
      paymentMethod: cod ? 'COD' : 'UPI', shipName: 'Remit Buyer', shipPhone: '9193300002', shipLine1: '1 Test Street', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
      payment: { create: { provider: 'mock', amountPaise: 50_000, status: cod ? 'CREATED' : 'PAID' } },
      items: { create: [{ productId, variantId, sellerId, title: 'Remit Tee', size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'CONFIRMED' }] },
    },
    include: { items: true },
  });
  orders.push(order.id);
  await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId, fileRef: 'asset:test' } });
  const itemId = order.items[0]!.id;
  expect((await call('PATCH', `/api/seller/orders/${itemId}/status`, { action: 'ship' })).status).toBe(200);
  expect((await call('PATCH', `/api/seller/orders/${itemId}/status`, { action: 'deliver' })).status).toBe(200);
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
  return { itemId, shipmentId: shipment.id, awb: shipment.awbNumber!, codPaise: shipment.codAmountPaise };
}

const eligibleIds = async () => (await eligibleItems(sellerId, 0)).map((i) => i.id);
const importCsv = (csv: string) => call('POST', '/api/admin/cod-remittances/import', { csv, fileName: 'remittance.csv' }, adminToken);

beforeAll(async () => {
  // No return-window hold here: only the remittance holds COD money back.
  await setSetting('payoutHoldDays', 0);
  const user = await prisma.user.create({ data: { phone: '9193300001', name: 'Remit Seller', role: Role.SELLER, referralCode: 'RMT-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName: 'Remit Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
        addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  const admin = await prisma.user.create({ data: { phone: '9193300003', name: 'Remit Admin', role: Role.ADMIN, referralCode: 'RMT-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  buyerId = (await prisma.user.create({ data: { phone: '9193300002', name: 'Remit Buyer', referralCode: 'RMT-B' } })).id;
  const category = await prisma.category.create({ data: { name: 'Remit Tees', slug: 'remit-tees', isActive: true } });
  productId = (
    await prisma.product.create({
      data: { sellerId, categoryId: category.id, title: 'Remit Tee', slug: 'remit-tee', description: 'For remittance tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300 },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-RMT', pricePaise: 50_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await setSetting('payoutHoldDays', DEFAULT_SETTINGS.payoutHoldDays);
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.sellerLedgerEntry.deleteMany({ where: { sellerId } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('COD money waits for Delhivery', () => {
  it('holds a delivered COD sale until its remittance is matched; a prepaid sale never waits', async () => {
    const cod = await delivered(true);
    const prepaid = await delivered(false);
    const ids = await eligibleIds();
    expect(ids).toContain(prepaid.itemId);
    expect(ids).not.toContain(cod.itemId);
    const pos = await settlementPosition(sellerId, 0);
    expect(pos.codAwaitingPaise).toBeGreaterThan(0);
    const insights = (await call('GET', '/api/seller/payouts/overview')).json.data.insights as { key: string }[];
    expect(insights.map((i) => i.key)).toContain('cod-remittance');
    // The admin sees it waiting.
    const overview = (await call('GET', '/api/admin/cod-remittances', undefined, adminToken)).json.data as { awaiting: { shipmentId: string }[] };
    expect(overview.awaiting.map((a) => a.shipmentId)).toContain(cod.shipmentId);
  });

  it('releases it when the report matches by AWB and amount, and flags the rows that don’t', async () => {
    const a = await delivered(true);
    const b = await delivered(true);
    const before = await settlementPosition(sellerId, 0);
    const rupees = (p: number) => (p / 100).toFixed(2);
    const csv = [
      'AWB No,Order Id,COD Amount,UTR No,Remittance Date',
      `${a.awb},x,"${rupees(a.codPaise)}",UTR-111,2026-10-25`,
      `${b.awb},x,${rupees(b.codPaise + 100)},UTR-111,2026-10-25`,
      'NOT-OURS-9,x,100.00,UTR-111,2026-10-25',
      `${a.awb},x,${rupees(a.codPaise)},UTR-111,2026-10-25`,
    ].join('\r\n');
    const r = await importCsv(csv);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data).toMatchObject({ matched: 1, mismatched: 1, unknown: 1, duplicate: 1 });
    expect((r.json.data.rows as { status: string }[]).map((x) => x.status)).toEqual(['MATCHED', 'MISMATCH', 'UNKNOWN', 'DUPLICATE']);
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: a.shipmentId } })).toMatchObject({ codRemittanceRef: 'UTR-111' });
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: b.shipmentId } })).codRemittedAt).toBeNull();
    const ids = await eligibleIds();
    expect(ids).toContain(a.itemId);
    expect(ids).not.toContain(b.itemId);
    expect((await settlementPosition(sellerId, 0)).availablePaise).toBeGreaterThan(before.availablePaise);
    // Imported again later: nothing new is released.
    expect((await importCsv(csv)).json.data).toMatchObject({ matched: 0, duplicate: 2 });
  });

  it('can be marked remitted by hand, with the bank reference — once, and only for a delivered COD parcel', async () => {
    const c = await delivered(true);
    const prepaid = await delivered(false);
    expect((await call('POST', `/api/admin/cod-remittances/parcels/${prepaid.shipmentId}/mark`, { reference: 'UTR-222' }, adminToken)).status).toBe(400);
    expect((await call('POST', `/api/admin/cod-remittances/parcels/${c.shipmentId}/mark`, { reference: 'UTR-222' }, adminToken)).status).toBe(200);
    expect((await call('POST', `/api/admin/cod-remittances/parcels/${c.shipmentId}/mark`, { reference: 'UTR-222' }, adminToken)).status).toBe(400);
    expect(await eligibleIds()).toContain(c.itemId);
  });

  it('refuses a report it can’t read, and is admin-only', async () => {
    expect((await importCsv('Order,Amount\r\nx,1')).status).toBe(400);
    expect((await call('GET', '/api/admin/cod-remittances')).status).toBe(403);
  });
});
