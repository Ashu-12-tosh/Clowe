import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { DEFAULT_LEGAL_ENTITY, type SellerOrderCharges, type SellerPayoutOverview, type SellerPenaltiesView } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { postDeliveryEntries } from '../services/sellerLedgerService';
import { chargeSellerCancelPenalty } from '../services/sellerCancellation';
import { issueMonthlyInvoice } from '../services/sellerInvoice';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * What a seller is charged, as they see it (owner, 26 Oct): every Clowe fee
 * with 18% GST on it as its own line — CGST + SGST in Clowe's state, IGST
 * otherwise — TDS and TCS apart, all adding up to what they are paid, on the
 * order page, the payouts page and the statement CSV; Delhivery's charges on
 * the order page with RTO and return lines; Clowe's monthly invoice numbered
 * CLW/<FY>/<n>, gap-free, as a PDF.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let sellerToken: string;
let buyerToken: string;
let addressId: string;
let sellerId: string;
let variantId: string;
const CLOWE_GSTIN = '07AAAAA0000A1Z5'; // Delhi, as Clowe's is

async function call<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

/** A paid order for one ₹1,000 unit (GST 18% inside), delivered, its fees on the ledger. */
async function deliveredLine() {
  expect((await call('POST', '/api/cart/items', buyerToken, { variantId, quantity: 1 })).status).toBe(200);
  const co = await call<{ orderId: string }>('POST', '/api/orders/checkout', buyerToken, { addressId, paymentMethod: 'UPI' });
  expect(co.status, JSON.stringify(co.json)).toBe(200);
  expect((await call('POST', '/api/payments/mock-pay', buyerToken, { orderId: co.json.data.orderId, outcome: 'success' })).status).toBe(200);
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: co.json.data.orderId } });
  await prisma.orderItem.update({ where: { id: item.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
  await postDeliveryEntries(item.id);
  return item;
}

let order: { orderId: string; itemId: string };

beforeAll(async () => {
  await setSetting('legalEntity', { ...DEFAULT_LEGAL_ENTITY, gstin: CLOWE_GSTIN });
  const sellerUser = await prisma.user.create({ data: { phone: '9177300001', name: 'GST Seller', role: Role.SELLER, referralCode: 'GST-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: sellerUser.id, shopName: 'GST Shop', slug: 'gst-shop', status: SellerStatus.APPROVED, approvedAt: new Date(),
        gstNumber: '07ABCDE1234F1Z5', addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  sellerToken = signAccessToken({ sub: sellerUser.id, role: 'SELLER' });
  const buyer = await prisma.user.create({ data: { phone: '9177300002', name: 'GST Buyer', referralCode: 'GST-B' } });
  buyerToken = signAccessToken({ sub: buyer.id, role: 'CUSTOMER' });
  addressId = (
    await prisma.address.create({ data: { userId: buyer.id, name: 'GST Buyer', phone: buyer.phone, line1: '1 Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', isDefault: true } })
  ).id;
  const category = await prisma.category.create({ data: { name: 'GST Gadgets', slug: 'gst-gadgets', isActive: true, defaultTaxRatePercent: 18 } });
  const productId = (
    await prisma.product.create({
      data: { sellerId, categoryId: category.id, title: 'GST Gadget', slug: 'gst-gadget', description: 'For the GST tests.', basePricePaise: 100_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-GST', pricePaise: 100_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const item = await deliveredLine();
  order = { orderId: item.orderId, itemId: item.id };
  // Its parcel: delivered, then re-weighed; and a second parcel that came back (RTO).
  const forward = await prisma.shipment.create({
    data: {
      orderId: item.orderId, sellerId, provider: 'mock', environment: 'mock', paymentType: 'PREPAID', weightGrams: 500, awbNumber: 'GST-AWB-1',
      status: 'DELIVERED', estimatedFreightPaise: 5_914, finalFreightPaise: 5_914, freightWeightGrams: 500, deliveredAt: new Date(), items: { connect: [{ id: item.id }] },
    },
  });
  const rto = await prisma.shipment.create({
    data: {
      orderId: item.orderId, sellerId, provider: 'mock', environment: 'mock', paymentType: 'PREPAID', weightGrams: 500, awbNumber: 'GST-AWB-2',
      status: 'RTO_DELIVERED', rtoInitiatedAt: new Date(), rtoDeliveredAt: new Date(), rtoReason: 'Consignee refused to accept',
      finalFreightPaise: 5_914, freightWeightGrams: 500, rtoFreightPaise: 5_384,
    },
  });
  for (const [type, amountPaise, key] of [
    ['FORWARD_FREIGHT', -5_914, `forward-freight:${forward.id}`],
    ['FREIGHT_ADJUSTMENT', -5_435, `freight-adjustment:${forward.id}:1`],
    // An RTO parcel pays its trip out as well as the trip back.
    ['FORWARD_FREIGHT', -5_914, `forward-freight:${rto.id}`],
    ['RTO_FREIGHT', -5_384, `rto-freight:${rto.id}`],
  ] as const) {
    await prisma.sellerLedgerEntry.create({ data: { sellerId, type, bucket: 'SETTLEMENT', amountPaise, orderId: item.orderId, idempotencyKey: key, note: `${type} test` } });
  }
});

afterAll(async () => {
  await setSetting('legalEntity', DEFAULT_SETTINGS.legalEntity);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the order page', () => {
  it('shows Clowe fees with GST @18% as CGST + SGST for a seller in Clowe\'s state, adding up to the payout', async () => {
    const r = await call<SellerOrderCharges>('GET', `/api/seller/orders/${order.orderId}/charges`, sellerToken);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.fees).toEqual({
      grossPaise: 100_000,
      referralPaise: 2_000,
      collectionPaise: 2_000,
      gtPaise: 1_500,
      handlingPaise: 1_900,
      otherFeesPaise: 0,
      gstPercent: 18,
      cloweFeeGstPaise: 1_332,
      intraState: true,
      cgstPaise: 666,
      sgstPaise: 666,
      igstPaise: 0,
      tdsPaise: 85,
      tcsPaise: 424,
      receivesPaise: 90_759,
    });
    // The ledger posted the same.
    const posted = await prisma.sellerLedgerEntry.findMany({ where: { orderItemId: order.itemId } });
    expect(posted.reduce((sum, e) => sum + e.amountPaise, 0)).toBe(90_759);
  });

  it('shows Delhivery\'s charges: at placement, at booking, actual, then each ledger line with its date and reason', async () => {
    const r = await call<SellerOrderCharges>('GET', `/api/seller/orders/${order.orderId}/charges`, sellerToken);
    const c = r.json.data;
    expect(c.placement).toMatchObject({ destinationPincode: '400001', freightEstimatePaise: expect.any(Number) });
    expect(c.parcels[0]).toMatchObject({ awbNumber: 'GST-AWB-1', bookingEstimatePaise: 5_914, chargedPaise: 5_914, chargedWeightGrams: 500 });
    expect(c.lines.map((l) => [l.kind, l.amountPaise, l.awbNumber])).toEqual([
      ['FORWARD', 5_914, 'GST-AWB-1'],
      ['WEIGHT_ADJUSTMENT', 5_435, 'GST-AWB-1'],
      ['FORWARD', 5_914, 'GST-AWB-2'],
      ['RTO', 5_384, 'GST-AWB-2'],
    ]);
    expect(c.lines[3]).toMatchObject({ reason: 'Consignee refused to accept', eventAt: expect.any(String) });
  });

  it('is the seller\'s own', async () => {
    const other = await prisma.user.create({ data: { phone: '9177300009', name: 'Other Seller', role: Role.SELLER, referralCode: 'GST-O' } });
    await prisma.sellerProfile.create({ data: { userId: other.id, shopName: 'Other GST Shop', status: SellerStatus.APPROVED, approvedAt: new Date() } });
    expect((await call('GET', `/api/seller/orders/${order.orderId}/charges`, signAccessToken({ sub: other.id, role: 'SELLER' }))).status).toBe(404);
  });
});

describe('payouts and the statement', () => {
  it('payouts: GST on Clowe fees and its split, weight adjustments apart from forward freight, TDS and TCS', async () => {
    const r = await call<SellerPayoutOverview>('GET', '/api/seller/payouts/overview', sellerToken);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.fees).toMatchObject({
      gtPaise: 1_500,
      handlingPaise: 1_900,
      cloweFeeGstPaise: 1_332,
      cloweFeeGst: { intraState: true, cgstPaise: 666, sgstPaise: 666, igstPaise: 0 },
      tdsPaise: 85,
      tcsPaise: 424,
      forwardFreightPaise: 2 * 5_914,
      freightAdjustmentPaise: 5_435,
      rtoFreightPaise: 5_384,
    });
  });

  it('statement CSV: the fees, their GST (CGST/SGST/IGST), TDS and TCS add up to the net; Delhivery rows carry the AWB; a total', async () => {
    const res = await fetch(`${base}/api/seller/payouts/statement`, { headers: { authorization: `Bearer ${sellerToken}` } });
    expect(res.status).toBe(200);
    const rows = (await res.text()).split('\n').map((l) => l.split(','));
    const head = rows[0]!;
    const col = (row: string[], h: string) => Math.round(Number(row[head.indexOf(h)] || 0) * 100);
    const sale = rows.find((r) => r[0] === 'Sale')!;
    expect(col(sale, 'Gross (INR)')).toBe(100_000);
    expect(col(sale, 'GST @18% on Clowe fees (INR)')).toBe(1_332);
    expect([col(sale, 'of which CGST (INR)'), col(sale, 'of which SGST (INR)'), col(sale, 'of which IGST (INR)')]).toEqual([666, 666, 0]);
    const deductions = ['Referral fee / commission (INR)', 'Collection fee / gateway (INR)', 'GT charge (INR)', 'Handling fee (INR)', 'Other Clowe fees on older orders (INR)', 'GST @18% on Clowe fees (INR)', 'TDS (INR)', 'GST TCS (INR)']
      .reduce((sum, h) => sum + col(sale, h), 0);
    expect(col(sale, 'Gross (INR)') - deductions).toBe(col(sale, 'Net (INR)'));
    expect(col(sale, 'Net (INR)')).toBe(90_759);
    const awb = head.indexOf('AWB');
    const kg = head.indexOf('Charged weight (kg)');
    expect(rows.filter((r) => r[awb] === 'GST-AWB-1').map((r) => r[0])).toEqual(['Delhivery freight', 'Freight adjustment']);
    expect(rows.filter((r) => r[awb] === 'GST-AWB-2').map((r) => r[kg])).toEqual(['0.500', '0.500']);
    const total = rows.at(-1)!;
    expect(total[0]).toBe('Total');
    expect(col(total, 'Net (INR)')).toBe(90_759 - 2 * 5_914 - 5_435 - 5_384);
  });
});

describe('penalties', () => {
  it('carry 18% GST, shown beside them — the seller-cancel penalty too, if it is ever charged again', async () => {
    await setSetting('penaltyEnabled', true);
    await setSetting('sellerCancelPenaltyPaise', 15_000);
    expect(await chargeSellerCancelPenalty(order.orderId, sellerId, 'Out of stock')).toBe(15_000);
    const penalty = await prisma.sellerLedgerEntry.findFirstOrThrow({ where: { sellerId, type: 'SELLER_CANCEL_PENALTY' } });
    expect(await prisma.sellerLedgerEntry.findUnique({ where: { idempotencyKey: `penalty-gst:${penalty.id}` } })).toMatchObject({ amountPaise: -2_700, type: 'CLOWE_FEE_GST' });
    const view = await call<SellerPenaltiesView>('GET', '/api/seller/ledger/penalties', sellerToken);
    expect(view.json.data.rows.find((r) => r.entryId === penalty.id)).toMatchObject({ amountPaise: 15_000, gstPaise: 2_700 });
  });
});

describe('Clowe\'s tax invoice', () => {
  async function sellerWithCharges(n: number, month: Date) {
    const u = await prisma.user.create({ data: { phone: `91773001${String(n).padStart(2, '0')}`, name: `Invoice Seller ${n}`, role: Role.SELLER, referralCode: `INV-${n}` } });
    const s = await prisma.sellerProfile.create({
      data: { userId: u.id, shopName: `Invoice Shop ${n}`, status: SellerStatus.APPROVED, approvedAt: new Date(), state: n % 2 ? 'Delhi' : 'Karnataka', gstNumber: null },
    });
    await prisma.sellerLedgerEntry.createMany({
      data: [
        { sellerId: s.id, type: 'SUBSCRIPTION_FEE', bucket: 'SETTLEMENT', amountPaise: -59_900, createdAt: month, idempotencyKey: `inv-plan:${s.id}` },
        { sellerId: s.id, type: 'CLOWE_FEE_GST', bucket: 'SETTLEMENT', amountPaise: -10_782, chargeType: 'SUBSCRIPTION_FEE', taxablePaise: 59_900, createdAt: month, idempotencyKey: `inv-plan-gst:${s.id}` },
      ],
    });
    return { id: s.id, token: signAccessToken({ sub: u.id, role: 'SELLER' }) };
  }

  it('numbers CLW/<FY>/<n>, at most 16 characters, consecutive even when issued at once; the place of supply decides CGST + SGST or IGST', async () => {
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15));
    const month = lastMonth.toISOString().slice(0, 7);
    const sellers = await Promise.all([1, 2, 3, 4].map((n) => sellerWithCharges(n, lastMonth)));
    const docs = await Promise.all(sellers.map((s) => issueMonthlyInvoice(s.id, month)));
    const numbers = docs.map((d) => d!.number!);
    for (const n of numbers) {
      expect(n).toMatch(/^CLW\/\d{4}\/\d{6}$/);
      expect(n.length).toBeLessThanOrEqual(16);
    }
    const seqs = numbers.map((n) => Number(n.slice(-6))).sort((a, b) => a - b);
    expect(seqs).toEqual([seqs[0], seqs[0]! + 1, seqs[0]! + 2, seqs[0]! + 3]);
    // Unregistered: the address decides. Delhi is Clowe's own state; Karnataka is not.
    expect(docs[0]).toMatchObject({ intraState: true, placeOfSupply: '07 Delhi', totals: { cgstPaise: 5_391, sgstPaise: 5_391, igstPaise: 0 } });
    expect(docs[1]).toMatchObject({ intraState: false, placeOfSupply: '29 Karnataka', totals: { igstPaise: 10_782 } });

    const pdf = await fetch(`${base}/api/seller/billing/invoices/${month}/pdf`, { headers: { authorization: `Bearer ${sellers[0]!.token}` } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toContain(numbers[0]!.replace(/\//g, '-'));
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
