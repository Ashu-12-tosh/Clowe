import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { balance, postLateDispatchPenalty } from '../services/sellerLedgerService';
import { signAccessToken } from '../utils/jwt';

/**
 * The late-dispatch penalty.
 *
 * A line shipped after placedAt + dispatchWindowHours costs the seller one
 * LATE_DISPATCH_PENALTY on their settlement ledger — one, whatever path
 * shipped it and however often it is replayed, because the ledger's
 * (orderItemId, type) pair refuses a second. An admin can forgive it once,
 * for the same structural reason. With the switch off, nothing is posted.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
let seq = 0;

const HOUR = 3_600_000;
const PENALTY = DEFAULT_SETTINGS.lateDispatchPenaltyPaise;

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirst({ where: { isActive: true } });
  if (!category) throw new Error('fixture produced no active category');
  categoryId = category.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await setSetting('penaltyEnabled', DEFAULT_SETTINGS.penaltyEnabled);
  await setSetting('dispatchWindowHours', DEFAULT_SETTINGS.dispatchWindowHours);
  await setSetting('lateDispatchPenaltyPaise', DEFAULT_SETTINGS.lateDispatchPenaltyPaise);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function makeSeller() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `96000${String(seq).padStart(5, '0')}`, name: `Late Seller ${seq}`, role: Role.SELLER, referralCode: `LATE-S-${seq}` },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Late Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      categoryId,
      title: `Late Product ${seq}`,
      slug: `late-product-${seq}`,
      description: 'Used by the late-dispatch regression tests.',
      basePricePaise: 100_000,
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
      sku: `SKU-LATE-${seq}`,
      pricePaise: 100_000,
      stock: 50,
    },
  });
  const shopper = await prisma.user.create({
    data: { phone: `97100${String(seq).padStart(5, '0')}`, name: `Late Shopper ${seq}`, referralCode: `LATE-U-${seq}` },
  });
  return { sellerId: seller.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }), product, variant, shopperId: shopper.id };
}

/** A confirmed, unshipped line placed `hoursAgo` hours ago, its packing video recorded. */
async function makeLine(s: Awaited<ReturnType<typeof makeSeller>>, hoursAgo: number) {
  seq += 1;
  const placedAt = new Date(Date.now() - hoursAgo * HOUR);
  const order = await prisma.order.create({
    data: {
      orderNumber: `CLW-LATE-${String(seq).padStart(6, '0')}`,
      userId: s.shopperId,
      shipName: 'Late Shopper',
      shipPhone: '9710000000',
      shipLine1: '1 Test Lane',
      shipCity: 'Mumbai',
      shipState: 'Maharashtra',
      shipPincode: '400001',
      status: 'CONFIRMED',
      subtotalPaise: 100_000,
      totalPaise: 100_000,
      paymentMethod: 'UPI',
      createdAt: placedAt,
      payment: { create: { provider: 'mock', amountPaise: 100_000, status: 'PAID' } },
    },
  });
  // Dispatch needs the clip; these tests are about the clock, not the clip.
  await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId: s.sellerId, fileRef: `asset:late-${seq}` } });
  return prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId: s.product.id,
      variantId: s.variant.id,
      sellerId: s.sellerId,
      title: s.product.title,
      size: 'M',
      color: '',
      pricePaise: 100_000,
      quantity: 1,
      status: 'CONFIRMED',
    },
  });
}

async function makeAdmin() {
  seq += 1;
  const admin = await prisma.user.create({
    data: { phone: `98100${String(seq).padStart(5, '0')}`, name: `Late Admin ${seq}`, role: Role.ADMIN, referralCode: `LATE-A-${seq}` },
  });
  return { id: admin.id, token: signAccessToken({ sub: admin.id, role: 'ADMIN' }) };
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: never; error?: { code: string; message: string } };
  return { status: res.status, json };
}

const ship = (s: { token: string }, itemId: string) =>
  call('PATCH', `/api/seller/orders/${itemId}/status`, s.token, { action: 'ship' });

async function penalties(orderItemId: string) {
  return prisma.sellerLedgerEntry.findMany({ where: { orderItemId, type: 'LATE_DISPATCH_PENALTY' } });
}

// ---------------------------------------------------------------------------

describe('shipping inside the window', () => {
  it('posts nothing', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 3);
    expect((await ship(s, line.id)).status).toBe(200);
    expect(await penalties(line.id)).toHaveLength(0);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);
  });
});

describe('shipping late', () => {
  it('posts one penalty with the arithmetic in its note', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 14);
    expect((await ship(s, line.id)).status).toBe(200);
    const rows = await penalties(line.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountPaise).toBe(-PENALTY);
    expect(rows[0].bucket).toBe('SETTLEMENT');
    expect(rows[0].note).toBe('Dispatched 14h after placement; window 12h');
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(-PENALTY);
  });

  it('is still one penalty after shipping again and replaying the poster', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 20);
    await ship(s, line.id);
    // The status machine refuses a second ship…
    expect((await ship(s, line.id)).status).toBe(400);
    // …and the poster itself, called straight, finds the pair already taken.
    expect(await postLateDispatchPenalty(line.id)).toBe(false);
    expect(await postLateDispatchPenalty(line.id)).toBe(false);
    expect(await penalties(line.id)).toHaveLength(1);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(-PENALTY);
  });

  it('follows the window and amount settings, not compiled-in numbers', async () => {
    await setSetting('dispatchWindowHours', 48);
    await setSetting('lateDispatchPenaltyPaise', 12_345);
    const s = await makeSeller();
    const onTimeNow = await makeLine(s, 20);
    await ship(s, onTimeNow.id);
    expect(await penalties(onTimeNow.id)).toHaveLength(0);

    const late = await makeLine(s, 50);
    await ship(s, late.id);
    const rows = await penalties(late.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountPaise).toBe(-12_345);
    expect(rows[0].note).toBe('Dispatched 50h after placement; window 48h');
  });

  it('posts nothing while penalties are switched off', async () => {
    await setSetting('penaltyEnabled', false);
    const s = await makeSeller();
    const line = await makeLine(s, 30);
    expect((await ship(s, line.id)).status).toBe(200);
    expect(await penalties(line.id)).toHaveLength(0);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);
  });

  it('leaves penalties already posted alone when switched off later', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 30);
    await ship(s, line.id);
    await setSetting('penaltyEnabled', false);
    expect(await penalties(line.id)).toHaveLength(1);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(-PENALTY);
  });
});

describe('waiving', () => {
  it('brings the balance back, is audit-logged, and cannot happen twice', async () => {
    const s = await makeSeller();
    const admin = await makeAdmin();
    const line = await makeLine(s, 16);
    await ship(s, line.id);
    const [penalty] = await penalties(line.id);

    const first = await call('POST', `/api/admin/sellers/${s.sellerId}/ledger/${penalty.id}/waive`, admin.token, {
      reason: 'Placed at 2am; shop opens at 10',
    });
    expect(first.status).toBe(200);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);

    const waiver = await prisma.sellerLedgerEntry.findFirst({ where: { orderItemId: line.id, type: 'PENALTY_WAIVER' } });
    expect(waiver?.amountPaise).toBe(PENALTY);
    expect(waiver?.createdById).toBe(admin.id);
    expect(waiver?.note).toBe('Waived: Placed at 2am; shop opens at 10');

    // Audit rows are written fire-and-forget; give the write a moment.
    await new Promise((r) => setTimeout(r, 200));
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'Penalty waived', entityId: penalty.id, actorId: admin.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect((audit?.metadata as { reason?: string })?.reason).toBe('Placed at 2am; shop opens at 10');

    const second = await call('POST', `/api/admin/sellers/${s.sellerId}/ledger/${penalty.id}/waive`, admin.token, {
      reason: 'Clicking again',
    });
    expect(second.status).toBe(409);
    expect(second.json.error?.code).toBe('ALREADY_WAIVED');
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);
  });

  it('refuses to waive anything that is not a penalty, or on the wrong seller', async () => {
    const s = await makeSeller();
    const other = await makeSeller();
    const admin = await makeAdmin();
    const line = await makeLine(s, 16);
    await ship(s, line.id);
    const [penalty] = await penalties(line.id);

    const wrongSeller = await call('POST', `/api/admin/sellers/${other.sellerId}/ledger/${penalty.id}/waive`, admin.token, {
      reason: 'Wrong shop entirely',
    });
    expect(wrongSeller.status).toBe(404);

    const notAdmin = await call('POST', `/api/admin/sellers/${s.sellerId}/ledger/${penalty.id}/waive`, s.token, {
      reason: 'Sellers cannot forgive themselves',
    });
    expect(notAdmin.status).toBe(403);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(-PENALTY);
  });
});

describe('what the seller is told', () => {
  it('publishes the window and the switch in public settings', async () => {
    const res = await fetch(`${base}/api/settings/public`);
    const json = (await res.json()) as { data: { dispatchWindowHours: number; penaltyEnabled: boolean } };
    expect(json.data.dispatchWindowHours).toBe(12);
    expect(json.data.penaltyEnabled).toBe(true);
  });

  it('shows the penalty and its reason on the seller ledger', async () => {
    const s = await makeSeller();
    const line = await makeLine(s, 15);
    await ship(s, line.id);
    const page = await call('GET', '/api/seller/ledger?bucket=SETTLEMENT', s.token);
    const rows = (page.json.data as { rows: { type: string; note: string | null; amountPaise: number }[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('LATE_DISPATCH_PENALTY');
    expect(rows[0].note).toBe('Dispatched 15h after placement; window 12h');
  });
});

type PenaltiesView = {
  rule: { enabled: boolean; penaltyPaise: number; windowHours: number };
  rows: {
    entryId: string;
    orderNumber: string | null;
    itemTitle: string | null;
    amountPaise: number;
    reason: string | null;
    waived: boolean;
    waiverNote: string | null;
  }[];
  total: number;
  chargedPaise: number;
  waivedPaise: number;
  netPaise: number;
};

const penaltiesView = async (token: string) =>
  (await call('GET', '/api/seller/ledger/penalties', token)).json.data as unknown as PenaltiesView;

describe('the payouts page penalties section', () => {
  it('answers with the rule from settings and empty rows when there are none', async () => {
    const s = await makeSeller();
    const view = await penaltiesView(s.token);
    expect(view.rule).toEqual({
      enabled: DEFAULT_SETTINGS.penaltyEnabled,
      penaltyPaise: DEFAULT_SETTINGS.lateDispatchPenaltyPaise,
      windowHours: DEFAULT_SETTINGS.dispatchWindowHours,
    });
    expect(view.rows).toEqual([]);
    expect([view.total, view.chargedPaise, view.waivedPaise, view.netPaise]).toEqual([0, 0, 0, 0]);

    await setSetting('penaltyEnabled', false);
    await setSetting('dispatchWindowHours', 48);
    await setSetting('lateDispatchPenaltyPaise', 12_345);
    expect((await penaltiesView(s.token)).rule).toEqual({ enabled: false, penaltyPaise: 12_345, windowHours: 48 });
  });

  it('lists each penalty with its order, reason and waived status, and totals them', async () => {
    const s = await makeSeller();
    const admin = await makeAdmin();
    const kept = await makeLine(s, 14);
    const forgiven = await makeLine(s, 18);
    await ship(s, kept.id);
    await ship(s, forgiven.id);
    const [toWaive] = await penalties(forgiven.id);
    const waive = await call('POST', `/api/admin/sellers/${s.sellerId}/ledger/${toWaive.id}/waive`, admin.token, {
      reason: 'Courier missed the pickup',
    });
    expect(waive.status).toBe(200);

    const view = await penaltiesView(s.token);
    expect(view.total).toBe(2);
    const byReason = new Map(view.rows.map((r) => [r.reason, r]));
    const keptRow = byReason.get('Dispatched 14h after placement; window 12h');
    const waivedRow = byReason.get('Dispatched 18h after placement; window 12h');
    expect(keptRow).toMatchObject({ amountPaise: PENALTY, waived: false, waiverNote: null, itemTitle: s.product.title });
    expect(keptRow?.orderNumber).toMatch(/^CLW-LATE-/);
    expect(waivedRow).toMatchObject({
      entryId: toWaive.id,
      amountPaise: PENALTY,
      waived: true,
      waiverNote: 'Waived: Courier missed the pickup',
    });
    expect(view.chargedPaise).toBe(2 * PENALTY);
    expect(view.waivedPaise).toBe(PENALTY);
    expect(view.netPaise).toBe(PENALTY);
    // The section and the ledger agree on what penalties cost.
    expect(-(await balance(s.sellerId, 'SETTLEMENT'))).toBe(view.netPaise);
  });

  it("shows only the signed-in seller's penalties", async () => {
    const s = await makeSeller();
    const other = await makeSeller();
    const line = await makeLine(s, 20);
    await ship(s, line.id);
    expect((await penaltiesView(s.token)).total).toBe(1);
    expect((await penaltiesView(other.token)).total).toBe(0);
  });
});

describe('the payouts page promotion balance', () => {
  it('answers at zero for a seller who never bought credits', async () => {
    const s = await makeSeller();
    const page = await call('GET', '/api/seller/ledger?bucket=PROMOTION&page=1&pageSize=5', s.token);
    expect(page.status).toBe(200);
    expect(page.json.data).toMatchObject({ bucket: 'PROMOTION', balancePaise: 0, rows: [], total: 0 });
  });
});
