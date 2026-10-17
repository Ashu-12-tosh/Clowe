import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SellerFeesV2 } from '@clowe/shared';
import { createApp } from '../app';
import { feeSnapshots } from '../services/commercial';
import { addMonth, admitToPlan, changePlan, enforceProductLimit, limitNoticeSweep, renewDue } from '../services/planService';
import { postEntry } from '../services/sellerLedgerService';
import { walletView } from '../services/wallet';
import { signAccessToken } from '../utils/jwt';
import { TEST_SELLER_ADDRESS } from '../test/fixture';

/**
 * Seller plans (owner's Batch 2): FREE, GROWTH ₹599, PRO ₹999, PREMIUM ₹1,999
 * a month plus GST; upgrades at once (prorated), downgrades at renewal,
 * renewal on the same date with the plan's advertising credit, 3 days' grace
 * then FREE, a live-product limit that hides (never deletes), sellers from
 * before the plans warned and given 30 days, and features gated by plan.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
let categoryId: string;
const DAY = 86_400_000;

async function seller(plan?: 'FREE' | 'GROWTH' | 'PRO' | 'PREMIUM') {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91964${String(seq).padStart(5, '0')}`, name: `Plan Seller ${seq}`, role: Role.SELLER, referralCode: `PLN-${seq}` } });
  const s = await prisma.sellerProfile.create({
    data: { ...TEST_SELLER_ADDRESS, userId: user.id, shopName: `Plan Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date(), ...(plan ? { subscription: { create: { plan } } } : {}) },
  });
  return { id: s.id, userId: user.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}
const topUp = (sellerId: string, paise: number) =>
  postEntry({ sellerId, type: 'PROMOTION_CREDIT_PURCHASE', bucket: 'PROMOTION', amountPaise: paise, note: 'test', idempotencyKey: `plan-topup:${sellerId}:${Math.random()}` });
async function products(sellerId: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    seq += 1;
    const p = await prisma.product.create({
      data: { sellerId, categoryId, title: `Plan Product ${seq}`, slug: `plan-product-${seq}`, description: 'Plan test.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date(), createdAt: new Date(Date.now() - (n - i) * 60_000) },
    });
    ids.push(p.id);
  }
  return ids; // oldest first
}
async function call<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

beforeAll(async () => {
  categoryId = (await prisma.category.create({ data: { name: 'Plan Things', slug: 'plan-things', isActive: true } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('upgrading and downgrading', () => {
  it('upgrades FREE → GROWTH at once for a month, charged with GST from the wallet', async () => {
    const s = await seller();
    await topUp(s.id, 100_000);
    const res = await call('POST', '/api/seller/billing/plan', s.token, { plan: 'GROWTH' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const sub = await prisma.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.id } });
    expect(sub.plan).toBe('GROWTH');
    expect(sub.periodEnd!.toISOString()).toBe(addMonth(sub.periodStart!).toISOString());
    expect((await walletView(s.id)).walletPaise).toBe(100_000 - 59_900 - 10_782);
  });

  it('refuses an upgrade the wallet and payable balance cannot cover', async () => {
    const s = await seller();
    expect((await call('POST', '/api/seller/billing/plan', s.token, { plan: 'PREMIUM' })).json.error?.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('prorates GROWTH → PRO for the rest of the month, and adds PRO’s advertising credit', async () => {
    const s = await seller();
    await topUp(s.id, 300_000);
    const start = new Date(Date.now() - 15 * DAY);
    await changePlan(s.id, 'GROWTH', start);
    const mid = new Date(start.getTime() + (addMonth(start).getTime() - start.getTime()) / 2);
    await changePlan(s.id, 'PRO', mid);
    const charges = await prisma.sellerLedgerEntry.findMany({ where: { sellerId: s.id, type: 'SUBSCRIPTION_FEE' } });
    expect(charges.reduce((a, c) => a - c.amountPaise, 0)).toBe(59_900 + 20_000); // half of ₹400
    expect((await walletView(s.id)).adCreditPaise).toBe(50_000);
  });

  it('downgrades at the renewal date, not before', async () => {
    const s = await seller();
    await topUp(s.id, 500_000);
    const start = new Date(Date.now() - 31 * DAY);
    await changePlan(s.id, 'PRO', start);
    await changePlan(s.id, 'GROWTH', new Date(start.getTime() + DAY));
    let sub = await prisma.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.id } });
    expect([sub.plan, sub.pendingPlan]).toEqual(['PRO', 'GROWTH']);
    await renewDue(new Date());
    sub = await prisma.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.id } });
    expect([sub.plan, sub.pendingPlan]).toEqual(['GROWTH', null]);
    expect(sub.periodStart!.toISOString()).toBe(addMonth(start).toISOString());
  });
});

describe('renewal', () => {
  it('renews on the same date, charging the month and giving the plan’s advertising credit', async () => {
    const s = await seller();
    await topUp(s.id, 500_000);
    const start = new Date(Date.UTC(2026, 8, 16, 6));
    await changePlan(s.id, 'PREMIUM', start);
    const r = await renewDue(new Date(Date.UTC(2026, 9, 16, 7)));
    expect(r.renewed).toBeGreaterThanOrEqual(1);
    const sub = await prisma.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.id } });
    expect(sub.periodStart!.toISOString()).toBe('2026-10-16T06:00:00.000Z');
    expect(sub.periodEnd!.toISOString()).toBe('2026-11-16T06:00:00.000Z');
    expect((await walletView(s.id)).adCreditPaise).toBe(200_000);
  });

  it('gives 3 days’ grace when money is short, then drops to FREE', async () => {
    const s = await seller();
    await topUp(s.id, 70_682);
    const start = new Date(Date.now() - 31 * DAY);
    await changePlan(s.id, 'GROWTH', start);
    const due = addMonth(start);
    await renewDue(new Date(due.getTime() + 60_000));
    let sub = await prisma.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.id } });
    expect(sub.plan).toBe('GROWTH');
    expect(sub.graceUntil!.getTime() - due.getTime()).toBe(3 * DAY);
    await renewDue(new Date(due.getTime() + 2 * DAY));
    expect((await prisma.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.id } })).plan).toBe('GROWTH');
    await renewDue(new Date(due.getTime() + 3 * DAY + 60_000));
    sub = await prisma.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.id } });
    expect([sub.plan, sub.graceUntil]).toEqual(['FREE', null]);
  });

  it('ends at the renewal date when auto-renew is off', async () => {
    const s = await seller();
    await topUp(s.id, 200_000);
    const start = new Date(Date.now() - 31 * DAY);
    await changePlan(s.id, 'GROWTH', start);
    expect((await call('POST', '/api/seller/billing/plan/auto-renew', s.token, { autoRenew: false })).status).toBe(200);
    await renewDue(new Date());
    expect((await prisma.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.id } })).plan).toBe('FREE');
    expect(await prisma.sellerLedgerEntry.count({ where: { sellerId: s.id, type: 'SUBSCRIPTION_FEE' } })).toBe(1);
  });
});

describe('the live-product limit', () => {
  it('on FREE keeps the 15 newest live and hides the rest, never deleting; the seller can choose', async () => {
    const s = await seller('FREE');
    const ids = await products(s.id, 18);
    await enforceProductLimit(s.id);
    const hidden = await prisma.product.findMany({ where: { sellerId: s.id, planHidden: true }, select: { id: true } });
    expect(hidden.map((h) => h.id).sort()).toEqual(ids.slice(0, 3).sort());
    expect(await prisma.product.count({ where: { sellerId: s.id } })).toBe(18);
    // A hidden product is gone from the shop.
    const pdp = await fetch(`${base}/api/products/${(await prisma.product.findUniqueOrThrow({ where: { id: ids[0]! } })).slug}`);
    expect(pdp.status).toBe(404);
    // The seller keeps the 3 oldest and 12 others live instead.
    const pick = [...ids.slice(0, 3), ...ids.slice(6)];
    expect((await call('POST', '/api/seller/billing/plan/live-products', s.token, { productIds: pick })).status).toBe(200);
    expect((await prisma.product.findMany({ where: { sellerId: s.id, planHidden: true }, select: { id: true } })).map((h) => h.id).sort()).toEqual(ids.slice(3, 6).sort());
    expect((await call('POST', '/api/seller/billing/plan/live-products', s.token, { productIds: ids })).json.error?.code).toBe('OVER_LIMIT');
    // A newly approved one waits hidden, so the picks stand.
    const [extra] = await products(s.id, 1);
    expect(await admitToPlan(extra!)).toBe(false);
  });

  it('gives sellers from before the plans 30 days, with one notice', async () => {
    const s = await seller();
    await prisma.sellerSubscription.create({ data: { sellerId: s.id, limitGraceUntil: new Date(Date.now() + 30 * DAY) } });
    await products(s.id, 17);
    await enforceProductLimit(s.id);
    expect(await prisma.product.count({ where: { sellerId: s.id, planHidden: true } })).toBe(0);
    expect(await limitNoticeSweep()).toBeGreaterThanOrEqual(1);
    await limitNoticeSweep();
    expect(await prisma.notification.count({ where: { userId: s.userId, type: 'SELLER_PLAN', title: { contains: 'FREE keeps 15' } } })).toBe(1);
    // When the 30 days are over, the limit applies.
    await limitNoticeSweep(new Date(Date.now() + 31 * DAY));
    expect(await prisma.product.count({ where: { sellerId: s.id, planHidden: true } })).toBe(2);
  });
});

describe('features by plan', () => {
  it('AI listing from GROWTH, promotion tools from GROWTH, 360° from PRO, AI marketing on PREMIUM', async () => {
    const free = await seller('FREE');
    const growth = await seller('GROWTH');
    const pro = await seller('PRO');
    const premium = await seller('PREMIUM');
    const describe = (t: string) => call('POST', '/api/ai/product-description', t, { title: 'Steel bottle', categoryName: 'Kitchen' });
    expect((await describe(free.token)).json.error?.code).toBe('PLAN_REQUIRED');
    expect((await describe(growth.token)).status).toBe(200);

    const [p] = await products(growth.id, 1);
    expect((await call('PUT', `/api/seller/products/${p}/spin-images`, growth.token, { imageUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] })).json.error?.code).toBe('PLAN_REQUIRED');
    const [q] = await products(pro.id, 1);
    expect((await call('PUT', `/api/seller/products/${q}/spin-images`, pro.token, { imageUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] })).status).toBe(200);
    const slug = (await prisma.product.findUniqueOrThrow({ where: { id: q! } })).slug;
    const spinOnPage = async () => ((await (await fetch(`${base}/api/products/${slug}`)).json()) as { data: { spinImages: string[] } }).data.spinImages;
    // Reviewed like product photos before shoppers see it.
    expect(await spinOnPage()).toHaveLength(0);
    const adminUser = await prisma.user.create({ data: { phone: `91965${String(++seq).padStart(5, '0')}`, name: 'Spin Admin', role: Role.ADMIN, referralCode: `SPIN-A-${seq}` } });
    const adminToken = signAccessToken({ sub: adminUser.id, role: 'ADMIN' });
    const queue = await call<{ id: string; pending: string[] }[]>('GET', '/api/admin/spin-reviews', adminToken);
    expect(queue.json.data.find((r) => r.id === q)?.pending).toHaveLength(2);
    expect((await call('POST', `/api/admin/spin-reviews/${q}`, adminToken, { action: 'reject' })).status).toBe(400);
    expect((await call('POST', `/api/admin/spin-reviews/${q}`, adminToken, { action: 'approve' })).status).toBe(200);
    expect(await spinOnPage()).toHaveLength(2);
    // A new set waits again; rejected, the approved one stays.
    await call('PUT', `/api/seller/products/${q}/spin-images`, pro.token, { imageUrls: ['https://cdn.example/c.jpg', 'https://cdn.example/d.jpg', 'https://cdn.example/e.jpg'] });
    expect(await spinOnPage()).toHaveLength(2);
    expect((await call('POST', `/api/admin/spin-reviews/${q}`, adminToken, { action: 'reject', reason: 'Blurred photos' })).status).toBe(200);
    expect(await spinOnPage()).toHaveLength(2);
    // Removing it takes effect at once.
    await call('PUT', `/api/seller/products/${q}/spin-images`, pro.token, { imageUrls: [] });
    expect(await spinOnPage()).toHaveLength(0);

    expect((await call('POST', '/api/ai/marketing', pro.token, { productId: q })).json.error?.code).toBe('PLAN_REQUIRED');
    const [r] = await products(premium.id, 1);
    const mk = await call<{ copy: string }>('POST', '/api/ai/marketing', premium.token, { productId: r, goal: 'Festive weekend' });
    expect(mk.status).toBe(200);
    expect(mk.json.data.copy).toContain('Social post');

    expect((await call('GET', '/api/seller/dashboard?range=QUARTER', free.token)).json.error?.code).toBe('PLAN_REQUIRED');
    expect((await call('GET', '/api/seller/dashboard?range=QUARTER', growth.token)).status).toBe(200);
    expect((await call('GET', '/api/seller/dashboard?range=YEAR', growth.token)).json.error?.code).toBe('PLAN_REQUIRED');
    expect((await call('GET', '/api/seller/customers', growth.token)).json.error?.code).toBe('PLAN_REQUIRED');
    expect((await call('GET', '/api/seller/customers', pro.token)).status).toBe(200);
  });

  it('puts Pro tickets at HIGH and Premium tickets at URGENT, dedicated', async () => {
    const pro = await seller('PRO');
    const premium = await seller('PREMIUM');
    const raise = (t: string) => call<{ id: string }>('POST', '/api/seller/support/tickets', t, { category: 'ORDERS', subject: 'Order help please', body: 'Where is the pickup for my order?', priority: 'LOW' });
    expect((await raise(pro.token)).status).toBe(200);
    expect((await raise(premium.token)).status).toBe(200);
    expect((await prisma.supportTicket.findFirstOrThrow({ where: { sellerId: pro.id } })).priority).toBe('HIGH');
    expect(await prisma.supportTicket.findFirstOrThrow({ where: { sellerId: premium.id } })).toMatchObject({ priority: 'URGENT', subject: '[Dedicated] Order help please' });
  });

  it('waives the handling fee on PREMIUM orders', async () => {
    const premium = await seller('PREMIUM');
    const [p] = await products(premium.id, 1);
    expect(((await feeSnapshots([{ productId: p!, sellerId: premium.id }])).get(p!) as SellerFeesV2).handlingWaived).toBe(true);
  });
});
