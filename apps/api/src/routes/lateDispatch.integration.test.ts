import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus, type OrderStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { balance } from '../services/sellerLedgerService';
import { chargeLateDispatchIfDue, sweepLateDispatch } from '../services/lateDispatch';
import { signAccessToken } from '../utils/jwt';

/**
 * The dispatch rules, all from settings.
 *
 * Sellers are promised dispatchSlaHours (18) to ship. The penalty falls due
 * later, lateDispatchPenaltyAfterHours (24) after placement: a seller whose
 * part of an order has not left by then is charged lateDispatchPenaltyPaise
 * once for that order, when the time runs out, whether it ships later or
 * never. The ledger's idempotency key is what makes it once. Lines cancelled
 * in time, lines awaiting payment and sellers on vacation are not charged.
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
  await setSetting('dispatchSlaHours', DEFAULT_SETTINGS.dispatchSlaHours);
  await setSetting('lateDispatchPenaltyAfterHours', DEFAULT_SETTINGS.lateDispatchPenaltyAfterHours);
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
  return {
    sellerId: seller.id,
    userId: user.id,
    token: signAccessToken({ sub: user.id, role: 'SELLER' }),
    product,
    variant,
    shopperId: shopper.id,
  };
}

type Seller = Awaited<ReturnType<typeof makeSeller>>;

/**
 * An order placed `hoursAgo` hours ago with `lines` lines of this seller's,
 * all in `status`, its packing video recorded (these tests are about the
 * clock, not the clip).
 */
async function makeOrder(s: Seller, hoursAgo: number, opts: { lines?: number; status?: OrderStatus } = {}) {
  seq += 1;
  const status = opts.status ?? 'CONFIRMED';
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
      status,
      subtotalPaise: 100_000,
      totalPaise: 100_000,
      paymentMethod: 'UPI',
      createdAt: new Date(Date.now() - hoursAgo * HOUR),
      payment: { create: { provider: 'mock', amountPaise: 100_000, status: status === 'PLACED' ? 'CREATED' : 'PAID' } },
    },
  });
  await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId: s.sellerId, fileRef: `asset:late-${seq}` } });
  const items = [];
  for (let i = 0; i < (opts.lines ?? 1); i += 1) {
    items.push(
      await prisma.orderItem.create({
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
          status,
        },
      }),
    );
  }
  return { order, items };
}

async function makeAdmin() {
  seq += 1;
  const admin = await prisma.user.create({
    data: { phone: `98100${String(seq).padStart(5, '0')}`, name: `Late Admin ${seq}`, role: Role.ADMIN, referralCode: `LATE-A-${seq}` },
  });
  return { id: admin.id, token: signAccessToken({ sub: admin.id, role: 'ADMIN' }) };
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: never; error?: { code: string; message: string } };
  return { status: res.status, json };
}

const ship = (s: { token: string }, itemId: string) =>
  call('PATCH', `/api/seller/orders/${itemId}/status`, s.token, { action: 'ship' });

const penaltiesOf = (orderId: string) =>
  prisma.sellerLedgerEntry.findMany({ where: { orderId, type: 'LATE_DISPATCH_PENALTY' } });

const hoursFromNow = (n: number) => new Date(Date.now() + n * HOUR);

// ---------------------------------------------------------------------------

describe('the rules', () => {
  it('come from settings and are published: an 18h promise, a 24h penalty, ₹80', async () => {
    const res = await call('GET', '/api/settings/public', null);
    const data = res.json.data as unknown as Record<string, unknown>;
    expect(data).toMatchObject({
      dispatchSlaHours: 18,
      lateDispatchPenaltyAfterHours: 24,
      lateDispatchPenaltyPaise: 8000,
      penaltyEnabled: true,
    });
    expect(data).not.toHaveProperty('dispatchWindowHours');
  });

  it('refuse a penalty that would fall due before the promise', async () => {
    const admin = await makeAdmin();
    const res = await call('PUT', '/api/admin/settings', admin.token, { lateDispatchPenaltyAfterHours: 10 });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('PENALTY_BEFORE_PROMISE');
  });
});

describe('shipping', () => {
  it('after the promise but before the penalty time costs nothing', async () => {
    const s = await makeSeller();
    const { order, items } = await makeOrder(s, 20);
    expect((await ship(s, items[0].id)).status).toBe(200);
    expect(await penaltiesOf(order.id)).toHaveLength(0);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);
  });

  it('after the penalty time charges one penalty, with the arithmetic in its note', async () => {
    const s = await makeSeller();
    const { order, items } = await makeOrder(s, 30);
    expect((await ship(s, items[0].id)).status).toBe(200);
    const rows = await penaltiesOf(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountPaise: -PENALTY, bucket: 'SETTLEMENT', orderItemId: null, sellerId: s.sellerId });
    expect(rows[0].note).toBe('Dispatched 30h after placement; penalty after 24h');
  });

  it('charges once per order, not once per item', async () => {
    const s = await makeSeller();
    const { order, items } = await makeOrder(s, 30, { lines: 3 });
    for (const item of items) expect((await ship(s, item.id)).status).toBe(200);
    expect(await penaltiesOf(order.id)).toHaveLength(1);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(-PENALTY);
  });
});

describe('the sweep', () => {
  it('charges an order never dispatched once the time runs out, and only once', async () => {
    const s = await makeSeller();
    const { order, items } = await makeOrder(s, 203, { lines: 2 });
    await sweepLateDispatch();
    const rows = await penaltiesOf(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe('Not dispatched within 24h of placement');

    // Running again, shipping later, and the ship-time check all find it charged.
    await sweepLateDispatch();
    expect((await ship(s, items[0].id)).status).toBe(200);
    expect(await chargeLateDispatchIfDue(order.id, s.sellerId)).toBe(false);
    expect(await penaltiesOf(order.id)).toHaveLength(1);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(-PENALTY);
  });

  it('leaves orders still inside the penalty time alone', async () => {
    const s = await makeSeller();
    const { order } = await makeOrder(s, 23);
    await sweepLateDispatch();
    expect(await penaltiesOf(order.id)).toHaveLength(0);
    // The same order an hour and a bit later is due.
    await sweepLateDispatch(hoursFromNow(1.1));
    expect(await penaltiesOf(order.id)).toHaveLength(1);
  });

  it('charges a part-shipped order whose other line is still waiting', async () => {
    const s = await makeSeller();
    const { order, items } = await makeOrder(s, 30, { lines: 2 });
    await prisma.orderItem.update({
      where: { id: items[0].id },
      data: { status: 'SHIPPED', shippedAt: new Date(order.createdAt.getTime() + 2 * HOUR) },
    });
    await sweepLateDispatch();
    expect(await penaltiesOf(order.id)).toHaveLength(1);
  });

  it('does not charge orders cancelled before the time ran out, or still awaiting payment', async () => {
    const s = await makeSeller();
    const cancelled = await makeOrder(s, 40, { status: 'CANCELLED' });
    const unpaid = await makeOrder(s, 40, { status: 'PLACED' });
    await sweepLateDispatch();
    expect(await penaltiesOf(cancelled.order.id)).toHaveLength(0);
    expect(await penaltiesOf(unpaid.order.id)).toHaveLength(0);
  });

  it('follows the time and amount settings, and charges nothing while switched off', async () => {
    await setSetting('lateDispatchPenaltyAfterHours', 48);
    await setSetting('lateDispatchPenaltyPaise', 12_345);
    const s = await makeSeller();
    const inside = await makeOrder(s, 40);
    const past = await makeOrder(s, 50);
    await sweepLateDispatch();
    expect(await penaltiesOf(inside.order.id)).toHaveLength(0);
    const rows = await penaltiesOf(past.order.id);
    expect(rows.map((r) => r.amountPaise)).toEqual([-12_345]);
    expect(rows[0].note).toBe('Not dispatched within 48h of placement');

    await setSetting('penaltyEnabled', false);
    const off = await makeOrder(s, 60);
    await sweepLateDispatch();
    expect(await penaltiesOf(off.order.id)).toHaveLength(0);
  });
});

describe('vacation', () => {
  const hoursBody = (vacationMode: boolean) => ({
    workingHours: Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '10:00', close: '19:00', closed: false }]),
    ),
    vacationMode,
  });

  it('records when it starts and ends, and pauses the penalty while on', async () => {
    const s = await makeSeller();
    const { order } = await makeOrder(s, 30);
    expect((await call('PUT', '/api/seller/store/hours', s.token, hoursBody(true))).status).toBe(200);
    const on = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.sellerId } });
    expect(on.vacationStartedAt).not.toBeNull();
    expect(on.vacationEndedAt).toBeNull();

    // Started after this order came in but before its deadline: paused.
    await prisma.sellerProfile.update({
      where: { id: s.sellerId },
      data: { vacationStartedAt: new Date(order.createdAt.getTime() + 10 * HOUR) },
    });
    await sweepLateDispatch(hoursFromNow(200));
    expect(await penaltiesOf(order.id)).toHaveLength(0);

    expect((await call('PUT', '/api/seller/store/hours', s.token, hoursBody(false))).status).toBe(200);
    const off = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.sellerId } });
    expect(off.vacationEndedAt).not.toBeNull();
  });

  it('moves the deadline by however long the clock was stopped', async () => {
    const s = await makeSeller();
    const { order } = await makeOrder(s, 30);
    const placed = order.createdAt.getTime();
    // Away from hour 10 to hour 20: the deadline moves from 24h to 34h, 4h from now.
    await prisma.sellerProfile.update({
      where: { id: s.sellerId },
      data: { vacationStartedAt: new Date(placed + 10 * HOUR), vacationEndedAt: new Date(placed + 20 * HOUR) },
    });
    await sweepLateDispatch();
    expect(await penaltiesOf(order.id)).toHaveLength(0);
    await sweepLateDispatch(hoursFromNow(5));
    const rows = await penaltiesOf(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe('Not dispatched within 24h of placement, plus 10h paused for vacation');
  });
});

describe('waiving', () => {
  it('forgives an order penalty once, audit-logged', async () => {
    const s = await makeSeller();
    const admin = await makeAdmin();
    const { order } = await makeOrder(s, 30);
    await sweepLateDispatch();
    const [penalty] = await penaltiesOf(order.id);

    const first = await call('POST', `/api/admin/sellers/${s.sellerId}/ledger/${penalty.id}/waive`, admin.token, {
      reason: 'Placed at 2am; shop opens at 10',
    });
    expect(first.status).toBe(200);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);
    const waiver = await prisma.sellerLedgerEntry.findFirst({ where: { orderId: order.id, type: 'PENALTY_WAIVER' } });
    expect(waiver).toMatchObject({ amountPaise: PENALTY, createdById: admin.id, orderItemId: null });

    await new Promise((r) => setTimeout(r, 200));
    const audit = await prisma.auditLog.findFirst({ where: { action: 'Penalty waived', entityId: penalty.id } });
    expect(audit).not.toBeNull();

    const second = await call('POST', `/api/admin/sellers/${s.sellerId}/ledger/${penalty.id}/waive`, admin.token, {
      reason: 'Clicking again',
    });
    expect(second.status).toBe(409);
    expect(await balance(s.sellerId, 'SETTLEMENT')).toBe(0);
  });

  it('refuses the wrong seller and non-admins', async () => {
    const s = await makeSeller();
    const other = await makeSeller();
    const admin = await makeAdmin();
    const { order } = await makeOrder(s, 30);
    await sweepLateDispatch();
    const [penalty] = await penaltiesOf(order.id);
    const wrong = await call('POST', `/api/admin/sellers/${other.sellerId}/ledger/${penalty.id}/waive`, admin.token, {
      reason: 'Wrong shop entirely',
    });
    expect(wrong.status).toBe(404);
    const notAdmin = await call('POST', `/api/admin/sellers/${s.sellerId}/ledger/${penalty.id}/waive`, s.token, {
      reason: 'Sellers cannot forgive themselves',
    });
    expect(notAdmin.status).toBe(403);
  });
});

describe('what the seller sees', () => {
  type Clock = { dispatchBy: string; penaltyAt: string | null; penaltyPaused: boolean; penaltyCharged: boolean } | null;
  const clockOf = async (s: Seller, orderId: string) =>
    ((await call('GET', `/api/seller/orders/${orderId}`, s.token)).json.data as unknown as { dispatch: Clock }).dispatch;

  it('gets both clocks on the order, and whether the penalty was charged', async () => {
    const s = await makeSeller();
    const { order, items } = await makeOrder(s, 2);
    const placed = order.createdAt.getTime();
    expect(await clockOf(s, order.id)).toMatchObject({
      dispatchBy: new Date(placed + 18 * HOUR).toISOString(),
      penaltyAt: new Date(placed + 24 * HOUR).toISOString(),
      penaltyPaused: false,
      penaltyCharged: false,
    });

    const late = await makeOrder(s, 203);
    await sweepLateDispatch();
    expect((await clockOf(s, late.order.id))?.penaltyCharged).toBe(true);

    // Nothing left to dispatch, nothing to count down.
    expect((await ship(s, items[0].id)).status).toBe(200);
    expect(await clockOf(s, order.id)).toBeNull();
  });

  it('is told the penalty is paused while on vacation', async () => {
    const s = await makeSeller();
    const { order } = await makeOrder(s, 2);
    await prisma.sellerProfile.update({ where: { id: s.sellerId }, data: { vacationMode: true, vacationStartedAt: new Date() } });
    expect(await clockOf(s, order.id)).toMatchObject({ penaltyAt: null, penaltyPaused: true });
  });

  it('sees the penalty, its order and its reason on the ledger and the payouts page', async () => {
    const s = await makeSeller();
    const { order } = await makeOrder(s, 30);
    await sweepLateDispatch();
    const page = await call('GET', '/api/seller/ledger?bucket=SETTLEMENT', s.token);
    const rows = (page.json.data as unknown as { rows: { type: string; note: string; reference: { orderNumber: string } }[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'LATE_DISPATCH_PENALTY', reference: { orderNumber: order.orderNumber } });

    const view = (await call('GET', '/api/seller/ledger/penalties', s.token)).json.data as unknown as {
      rule: Record<string, unknown>;
      rows: { orderNumber: string; amountPaise: number; reason: string; waived: boolean }[];
    };
    expect(view.rule).toEqual({ enabled: true, penaltyPaise: PENALTY, afterHours: 24, slaHours: 18 });
    expect(view.rows).toEqual([
      expect.objectContaining({
        orderNumber: order.orderNumber,
        amountPaise: PENALTY,
        reason: 'Not dispatched within 24h of placement',
        waived: false,
      }),
    ]);
  });

  it("shows only the signed-in seller's penalties", async () => {
    const s = await makeSeller();
    const other = await makeSeller();
    await makeOrder(s, 30);
    await sweepLateDispatch();
    const total = async (t: string) =>
      ((await call('GET', '/api/seller/ledger/penalties', t)).json.data as unknown as { total: number }).total;
    expect(await total(s.token)).toBe(1);
    expect(await total(other.token)).toBe(0);
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
