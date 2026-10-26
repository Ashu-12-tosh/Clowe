import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus, type ShipmentKind, type ShipmentStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { postForwardFreight, postReturnFreight, postRtoFreight } from '../services/shipping/freight';
import { signAccessToken } from '../utils/jwt';

/**
 * Delhivery's monthly bill, checked against what sellers were charged. An
 * admin uploads the billing export; each charge is matched by AWB and trip
 * (forward, RTO, return pickup) to the seller ledger, and the differences are
 * shown per seller. Nothing is posted until an admin confirms a line, and a
 * line posts once, however often it is confirmed.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let sellerToken: string;
let sellerA: string;
let sellerB: string;
let productId: string;
let variantId: string;
let buyerId: string;
let seq = 0;
const orders: string[] = [];
const TEST_RATE = 7_000; // the mock's flat forward rate for this file

type Json = { data: Record<string, unknown>; error?: { message: string; code?: string } };
async function call(method: string, path: string, body?: unknown, auth = adminToken) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

/** A parcel of ours, at the status given, with the freight the ledger would have posted for it by then. */
async function parcel(sellerId: string, awb: string, kind: ShipmentKind, status: ShipmentStatus) {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-44${String(seq).padStart(4, '0')}`, status: 'CONFIRMED', subtotalPaise: 50_000, shippingPaise: 0, totalPaise: 50_000,
      paymentMethod: 'UPI', shipName: 'Bill Buyer', shipPhone: '9144400002', shipLine1: '1 Test Street', shipCity: 'Mumbai', shipState: 'Maharashtra', shipPincode: '400001',
      payment: { create: { provider: 'mock', amountPaise: 50_000, status: 'PAID' } },
      items: { create: [{ productId, variantId, sellerId, title: 'Bill Tee', size: '', color: '', pricePaise: 50_000, quantity: 1, status: 'CONFIRMED' }] },
    },
  });
  orders.push(order.id);
  const s = await prisma.shipment.create({
    data: { orderId: order.id, sellerId, kind, status, awbNumber: awb, provider: 'mock', environment: 'staging', paymentType: 'PREPAID', weightGrams: 500 },
  });
  if (kind === 'REVERSE') await postReturnFreight(s.id);
  else if (status === 'RTO_DELIVERED') await postRtoFreight(s.id);
  else await postForwardFreight(s.id);
  return { shipmentId: s.id, orderId: order.id };
}

const freightEntries = (sellerId: string) =>
  prisma.sellerLedgerEntry.findMany({
    where: { sellerId, type: { in: ['FORWARD_FREIGHT', 'FREIGHT_ADJUSTMENT', 'RTO_FREIGHT', 'RETURN_FREIGHT'] } },
    orderBy: { createdAt: 'asc' },
  });
const charged = async (type: 'RTO_FREIGHT' | 'RETURN_FREIGHT', orderId: string) =>
  -(await prisma.sellerLedgerEntry.findFirstOrThrow({ where: { orderId, type } })).amountPaise;
const rupees = (paise: number) => (paise / 100).toFixed(2);

const upload = (csv: string, month = '2026-10') => call('POST', '/api/admin/delhivery-billing/checks', { month, fileName: `billing-${month}.csv`, csv });
const setColumns = (over: Record<string, unknown>) =>
  call('PUT', '/api/admin/delhivery-billing/columns', {
    awb: null, weight: null, forward: null, rto: null, dto: null, total: null, gst: null, weightUnit: 'KG', amountsIncludeGst: true, ...over,
  });
type Summary = { counts: Record<string, number>; differencePaise: number; sellers: { sellerId: string | null; differencePaise: number; shopName: string | null }[] };
type Line = { id: string; awbNumber: string; kind: string; status: string; billedPaise: number; ledgerPaise: number | null; differencePaise: number; sellerId: string | null; adjustedAt: string | null };
const lineOf = (lines: Line[], awb: string, kind: string) => lines.find((l) => l.awbNumber === awb && l.kind === kind)!;

let rto: { shipmentId: string; orderId: string };
let ret: { shipmentId: string; orderId: string };
let csv: string;

beforeAll(async () => {
  await setSetting('deliveryFeePaise', TEST_RATE);
  const mk = async (phone: string, shopName: string, code: string) => {
    const user = await prisma.user.create({ data: { phone, name: shopName, role: Role.SELLER, referralCode: code } });
    const seller = await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName, status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
        addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    });
    return { userId: user.id, sellerId: seller.id };
  };
  const a = await mk('9144400001', 'Bill Shop A', 'BIL-A');
  sellerA = a.sellerId;
  sellerToken = signAccessToken({ sub: a.userId, role: 'SELLER' });
  sellerB = (await mk('9144400003', 'Bill Shop B', 'BIL-B')).sellerId;
  const admin = await prisma.user.create({ data: { phone: '9144400004', name: 'Bill Admin', role: Role.ADMIN, referralCode: 'BIL-ADM' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  buyerId = (await prisma.user.create({ data: { phone: '9144400002', name: 'Bill Buyer', referralCode: 'BIL-BUY' } })).id;
  const category = await prisma.category.create({ data: { name: 'Bill Tees', slug: 'bill-tees', isActive: true } });
  productId = (
    await prisma.product.create({
      data: { sellerId: sellerA, categoryId: category.id, title: 'Bill Tee', slug: 'bill-tee', description: 'For billing tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 500 },
    })
  ).id;
  variantId = (await prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-BIL', pricePaise: 50_000, stock: 50 } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await parcel(sellerA, 'BC1', 'FORWARD', 'DELIVERED'); // billed as charged
  await parcel(sellerA, 'BC2', 'FORWARD', 'DELIVERED'); // billed more, at 1 kg
  rto = await parcel(sellerA, 'BC3', 'FORWARD', 'RTO_DELIVERED'); // RTO billed less
  ret = await parcel(sellerB, 'BC4', 'REVERSE', 'DELIVERED'); // a customer return, billed as charged
  await parcel(sellerB, 'BC5', 'FORWARD', 'IN_TRANSIT'); // nothing charged yet
  await parcel(sellerB, 'BC6', 'FORWARD', 'DELIVERED'); // same amount, a different weight
  csv = [
    'Waybill No,Charged Weight,Freight Charges,RTO Charges,Status',
    `BC1,0.5,${rupees(TEST_RATE)},,Delivered`,
    `BC2,1,${rupees(9_440)},,Delivered`,
    `BC3,0.5,${rupees(TEST_RATE)},${rupees((await charged('RTO_FREIGHT', rto.orderId)) - 500)},RTO`,
    `BC4,,${rupees(await charged('RETURN_FREIGHT', ret.orderId))},,Delivered`,
    `BC5,0.5,${rupees(TEST_RATE)},,In transit`,
    `BC6,1.5,${rupees(TEST_RATE)},,Delivered`,
    `NOPE1,0.5,50.00,,Delivered`,
  ].join('\r\n');
});

afterAll(async () => {
  await setSetting('deliveryFeePaise', DEFAULT_SETTINGS.deliveryFeePaise);
  await prisma.platformSetting.deleteMany({ where: { key: 'delhiveryBillingColumns' } });
  await prisma.delhiveryBillingCheck.deleteMany({ where: { month: { in: ['2026-10', '2026-09'] } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.sellerLedgerEntry.deleteMany({ where: { sellerId: { in: [sellerA, sellerB] } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the billing check', () => {
  it('is for admins only', async () => {
    expect((await call('GET', '/api/admin/delhivery-billing/checks', undefined, sellerToken)).status).toBe(403);
    expect((await call('POST', '/api/admin/delhivery-billing/checks', { month: '2026-10', fileName: 'x.csv', csv: 'AWB,Freight\n1,2' }, sellerToken)).status).toBe(403);
  });

  it("refuses a file whose AWB column it can't find, naming the columns it saw — until the admin maps it", async () => {
    const odd = 'Consignment,Freight\r\nBC1,70.00';
    const r = await upload(odd);
    expect(r.status).toBe(400);
    expect(r.json.error!.message).toMatch(/AWB column.*"Consignment", "Freight"/);
    expect((await setColumns({ awb: 'Consignment' })).status).toBe(200);
    const ok = await upload(odd, '2026-09');
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.data.columnsUsed).toMatchObject({ awb: 'Consignment', forward: 'Freight' });
    expect((ok.json.data.lines as Line[]).map((l) => [l.awbNumber, l.status])).toEqual([['BC1', 'MATCHED']]);
    // The mapping is kept, and the last file's header offered to pick from.
    const view = (await call('GET', '/api/admin/delhivery-billing/columns')).json.data;
    expect(view).toMatchObject({ columns: { awb: 'Consignment' }, lastHeaders: ['Consignment', 'Freight'], lastFileName: 'billing-2026-09.csv' });
    expect((await setColumns({})).status).toBe(200);
  });

  it('rejects a mapping or an upload that is not well formed', async () => {
    expect((await call('PUT', '/api/admin/delhivery-billing/columns', { weightUnit: 'POUNDS' })).status).toBe(400);
    expect((await upload('AWB,Freight\nBC1,70', '2026-13')).status).toBe(400);
  });

  it('matches each charge to the ledger by AWB and trip, and posts nothing', async () => {
    const before = [...(await freightEntries(sellerA)), ...(await freightEntries(sellerB))].length;
    const r = await upload(csv);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const lines = r.json.data.lines as Line[];
    const rtoCharged = await charged('RTO_FREIGHT', rto.orderId);
    expect(lines.map((l) => [l.awbNumber, l.kind, l.status, l.differencePaise]).sort()).toEqual(
      [
        ['BC1', 'FORWARD', 'MATCHED', 0],
        ['BC2', 'FORWARD', 'MISMATCH', 2_440],
        ['BC3', 'FORWARD', 'MATCHED', 0],
        ['BC3', 'RTO', 'MISMATCH', -500],
        ['BC4', 'DTO', 'MATCHED', 0],
        ['BC5', 'FORWARD', 'NOT_ON_LEDGER', TEST_RATE],
        ['BC6', 'FORWARD', 'MISMATCH', 0],
        ['NOPE1', 'FORWARD', 'UNKNOWN_AWB', 5_000],
      ].sort(),
    );
    expect(lineOf(lines, 'BC3', 'RTO')).toMatchObject({ billedPaise: rtoCharged - 500, ledgerPaise: rtoCharged });
    expect(lineOf(lines, 'BC5', 'FORWARD')).toMatchObject({ ledgerPaise: null });
    expect(lineOf(lines, 'BC6', 'FORWARD')).toMatchObject({ billedWeightGrams: 1_500, ledgerWeightGrams: 500 });
    expect(lineOf(lines, 'NOPE1', 'FORWARD')).toMatchObject({ sellerId: null, shipmentId: null });

    const summary = r.json.data.summary as Summary;
    expect(summary.counts).toEqual({ MATCHED: 3, MISMATCH: 3, NOT_ON_LEDGER: 1, UNKNOWN_AWB: 1 });
    expect(summary.differencePaise).toBe(2_440 - 500 + TEST_RATE);
    const bySeller = Object.fromEntries(summary.sellers.map((s) => [s.sellerId ?? 'none', s]));
    expect(bySeller[sellerA]).toMatchObject({ shopName: 'Bill Shop A', differencePaise: 1_940, lines: 4 });
    expect(bySeller[sellerB]).toMatchObject({ shopName: 'Bill Shop B', differencePaise: TEST_RATE, lines: 3 });
    expect(bySeller.none).toMatchObject({ differencePaise: 5_000, lines: 1 });
    expect(r.json.data.skipped).toEqual([]);
    // Checking posts nothing.
    expect([...(await freightEntries(sellerA)), ...(await freightEntries(sellerB))]).toHaveLength(before);
  });

  it('lists the checks, and filters one by status and seller', async () => {
    const list = (await call('GET', '/api/admin/delhivery-billing/checks')).json.data as unknown as { id: string; month: string; counts: Record<string, number> }[];
    const check = list.find((c) => c.month === '2026-10')!;
    expect(check.counts).toMatchObject({ MISMATCH: 3, UNKNOWN_AWB: 1 });
    const mism = (await call('GET', `/api/admin/delhivery-billing/checks/${check.id}?status=MISMATCH&sellerId=${sellerA}`)).json.data;
    expect((mism.lines as Line[]).map((l) => l.awbNumber).sort()).toEqual(['BC2', 'BC3']);
    // The summary is the whole check's, whatever the filter.
    expect((mism.summary as Summary).counts.MATCHED).toBe(3);
    expect((await call('GET', '/api/admin/delhivery-billing/checks/nope')).status).toBe(404);
  });
});

describe('adjusting a line', () => {
  let check: { id: string; lines: Line[] };
  const adjust = (id: string, body: unknown = { confirm: true }) => call('POST', `/api/admin/delhivery-billing/lines/${id}/adjust`, body);

  beforeAll(async () => {
    const list = (await call('GET', '/api/admin/delhivery-billing/checks')).json.data as unknown as { id: string; month: string }[];
    check = (await call('GET', `/api/admin/delhivery-billing/checks/${list.find((c) => c.month === '2026-10')!.id}`)).json.data as unknown as typeof check;
  });

  it('needs the confirmation', async () => {
    const line = lineOf(check.lines, 'BC2', 'FORWARD');
    expect((await adjust(line.id, {})).status).toBe(400);
    expect((await adjust(line.id, { confirm: 'yes' })).status).toBe(400);
    expect(await prisma.sellerLedgerEntry.count({ where: { idempotencyKey: `billing-check:${line.id}` } })).toBe(0);
  });

  it('posts the difference as a freight adjustment, once, however often it is confirmed', async () => {
    const line = lineOf(check.lines, 'BC2', 'FORWARD');
    const [first, second] = await Promise.all([adjust(line.id), adjust(line.id)]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    const entries = await prisma.sellerLedgerEntry.findMany({ where: { idempotencyKey: `billing-check:${line.id}` } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sellerId: sellerA, type: 'FREIGHT_ADJUSTMENT', bucket: 'SETTLEMENT', amountPaise: -2_440 });
    expect(entries[0]!.note).toMatch(/^Delhivery billing check 2026-10: AWB BC2 forward, CLW-.*billed ₹94\.40 vs charged ₹70\.00$/);
    const done = (first.status === 200 ? first : second).json.data as unknown as Line & { adjustmentEntryId: string };
    expect(done).toMatchObject({ id: line.id, adjustmentEntryId: entries[0]!.id });
    expect(done.adjustedAt).not.toBeNull();
    const again = await adjust(line.id);
    expect(again.json.error!.code).toBe('ALREADY_ADJUSTED');
    // Audited, as other admin money actions are.
    let audit = null;
    for (let i = 0; i < 20 && !audit; i++) {
      audit = await prisma.auditLog.findFirst({ where: { action: 'Delhivery billing adjustment', entityId: entries[0]!.id } });
      if (!audit) await new Promise((r) => setTimeout(r, 100));
    }
    expect(audit).toMatchObject({ module: 'PAYOUTS', actorRole: 'ADMIN' });
  });

  it('credits the seller when Delhivery billed less', async () => {
    const line = lineOf(check.lines, 'BC3', 'RTO');
    expect((await adjust(line.id)).status).toBe(200);
    expect(await prisma.sellerLedgerEntry.findUnique({ where: { idempotencyKey: `billing-check:${line.id}` } })).toMatchObject({ amountPaise: 500 });
  });

  it('charges the whole bill for a trip not charged yet', async () => {
    const line = lineOf(check.lines, 'BC5', 'FORWARD');
    expect((await adjust(line.id)).status).toBe(200);
    expect(await prisma.sellerLedgerEntry.findUnique({ where: { idempotencyKey: `billing-check:${line.id}` } })).toMatchObject({ sellerId: sellerB, amountPaise: -TEST_RATE });
    // The trip now stands charged at the bill, so delivery won't post its freight again.
    expect(await prisma.shipment.findFirstOrThrow({ where: { awbNumber: 'BC5' } })).toMatchObject({ finalFreightPaise: TEST_RATE });
  });

  it("never adjusts an AWB that isn't ours, or a line with no difference", async () => {
    expect((await adjust(lineOf(check.lines, 'NOPE1', 'FORWARD').id)).json.error!.code).toBe('UNKNOWN_AWB');
    expect((await adjust(lineOf(check.lines, 'BC1', 'FORWARD').id)).json.error!.code).toBe('NOTHING_TO_ADJUST');
    // A weight-only difference is shown, but moves no money.
    expect((await adjust(lineOf(check.lines, 'BC6', 'FORWARD').id)).json.error!.code).toBe('NOTHING_TO_ADJUST');
    expect((await adjust('nope')).status).toBe(404);
  });

  it('counts its adjustments when the same file is checked again, and refuses a stale line', async () => {
    const r = await upload(csv);
    const lines = r.json.data.lines as Line[];
    // Adjusted, the parcel stands charged at the bill, weight included.
    expect(lineOf(lines, 'BC2', 'FORWARD')).toMatchObject({ status: 'MATCHED', ledgerPaise: 9_440, differencePaise: 0 });
    expect(lineOf(lines, 'BC3', 'RTO')).toMatchObject({ status: 'MATCHED', differencePaise: 0 });
    expect(lineOf(lines, 'BC5', 'FORWARD')).toMatchObject({ status: 'MATCHED', ledgerPaise: TEST_RATE });
    // Freight posted for it again some other way (by hand, say): checked
    // again, the seller is now charged twice, and a line says so.
    const bc5 = await prisma.shipment.findFirstOrThrow({ where: { awbNumber: 'BC5' } });
    await prisma.sellerLedgerEntry.create({
      data: { sellerId: sellerB, type: 'FORWARD_FREIGHT', bucket: 'SETTLEMENT', amountPaise: -TEST_RATE, orderId: bc5.orderId, idempotencyKey: `forward-freight:${bc5.id}` },
    });
    const third = await upload(`Waybill,Freight Charges\r\nBC5,${rupees(TEST_RATE)}`);
    const line = lineOf(third.json.data.lines as Line[], 'BC5', 'FORWARD');
    expect(line).toMatchObject({ status: 'MISMATCH', ledgerPaise: 2 * TEST_RATE, differencePaise: -TEST_RATE });
    // Put right by hand before the admin gets to it: that line is stale now, and refused.
    await prisma.sellerLedgerEntry.create({
      data: { sellerId: sellerB, type: 'FREIGHT_ADJUSTMENT', bucket: 'SETTLEMENT', amountPaise: TEST_RATE, orderId: bc5.orderId, idempotencyKey: `freight-adjustment:${bc5.id}:1` },
    });
    const refused = await adjust(line.id);
    expect(refused.json.error!.code).toBe('LEDGER_CHANGED');
    expect(await prisma.sellerLedgerEntry.count({ where: { idempotencyKey: `billing-check:${line.id}` } })).toBe(0);
  });

  it('reads amounts before GST with the GST column added', async () => {
    expect((await setColumns({ amountsIncludeGst: false })).status).toBe(200);
    const r = await upload(`AWB,Freight,GST\r\nBC1,${rupees(Math.round(TEST_RATE / 1.18))},${rupees(TEST_RATE - Math.round(TEST_RATE / 1.18))}`, '2026-09');
    expect(lineOf(r.json.data.lines as Line[], 'BC1', 'FORWARD')).toMatchObject({ billedPaise: TEST_RATE, status: 'MATCHED' });
    expect((await setColumns({})).status).toBe(200);
  });
});
