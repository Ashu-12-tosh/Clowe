import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { attributeOrder, istDay, registerClick, serveAds } from '../services/advertising';
import { updateCommercial } from '../services/commercial';
import { postEntry } from '../services/sellerLedgerService';
import { walletView } from '../services/wallet';
import { signAccessToken } from '../utils/jwt';
import { TEST_SELLER_ADDRESS } from '../test/fixture';

/**
 * Advertising and sponsorship (owner's Batch 2): a click counts (and is
 * charged) once per shopper or device, product and campaign in 24 hours —
 * never the seller's own, never a bot; spend comes from advertising credit,
 * then the wallet; a campaign stops serving at its budget; placements are
 * booked on one calendar shared by advertising and sponsorship, never twice;
 * a rejected creative frees its days and is refunded; an order within 7 days
 * of a click is attributed to the ad; every paid item is labelled.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
let categoryId: string;
const DAY = 86_400_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const orders: string[] = [];

async function seller(plan?: 'FREE' | 'PREMIUM') {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91975${String(seq).padStart(5, '0')}`, name: `Ad Seller ${seq}`, role: Role.SELLER, referralCode: `ADS-${seq}` } });
  const s = await prisma.sellerProfile.create({
    data: { ...TEST_SELLER_ADDRESS, userId: user.id, shopName: `Ad Shop ${seq}`, slug: `ad-shop-${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date(), ...(plan ? { subscription: { create: { plan } } } : {}) },
  });
  const product = await prisma.product.create({
    data: { sellerId: s.id, categoryId, title: `Kurta Advert ${seq}`, slug: `kurta-advert-${seq}`, description: 'Ad test.', basePricePaise: 100_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, optionValues: { size: 'M' }, optionsKey: 'size:M', label: 'M', size: 'M', color: '', sku: `SKU-ADS-${seq}`, pricePaise: 100_000, stock: 10 },
  });
  return { id: s.id, userId: user.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }), productId: product.id, variantId: variant.id };
}
async function shopper() {
  seq += 1;
  const u = await prisma.user.create({ data: { phone: `91976${String(seq).padStart(5, '0')}`, name: `Ad Shopper ${seq}`, referralCode: `ADU-${seq}` } });
  return { id: u.id, token: signAccessToken({ sub: u.id, role: 'CUSTOMER' }) };
}
async function admin() {
  seq += 1;
  const u = await prisma.user.create({ data: { phone: `91977${String(seq).padStart(5, '0')}`, name: `Ad Admin ${seq}`, role: Role.ADMIN, referralCode: `ADA-${seq}` } });
  return signAccessToken({ sub: u.id, role: 'ADMIN' });
}
const topUp = (sellerId: string, paise: number) =>
  postEntry({ sellerId, type: 'PROMOTION_CREDIT_PURCHASE', bucket: 'PROMOTION', amountPaise: paise, note: 'test', idempotencyKey: `ad-topup:${sellerId}:${Math.random()}` });
async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'user-agent': UA, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}
const dayStr = (offset: number) => new Date(istDay(new Date()).getTime() + offset * DAY).toISOString().slice(0, 10);

beforeAll(async () => {
  categoryId = (await prisma.category.create({ data: { name: 'Ad Things', slug: 'ad-things', isActive: true } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // Orders made here go with this file, so the next file's reset is clean.
  await prisma.adAttribution.deleteMany({});
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('pay-per-click campaigns', () => {
  it('refuses a bid outside the type’s range, and accepts one inside it', async () => {
    const s = await seller();
    const low = await call('POST', '/api/seller/advertising/cpc', s.token, { name: 'Too low', adTypes: ['TOP_SEARCH'], productId: s.productId, bidPaise: 500, dailyBudgetPaise: 10_000 });
    expect(low.json.error?.code).toBe('BID_OUT_OF_RANGE');
    const ok = await call('POST', '/api/seller/advertising/cpc', s.token, { name: 'Top', adTypes: ['TOP_SEARCH'], productId: s.productId, bidPaise: 900, dailyBudgetPaise: 10_000 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
  });

  it('sells AI Compare Promotion now that Compare exists, and refuses a type the admin switches off', async () => {
    const s = await seller();
    const ok = await call('POST', '/api/seller/advertising/cpc', s.token, { name: 'Compare', adTypes: ['COMPARE_PROMOTION'], productId: s.productId, bidPaise: 500, dailyBudgetPaise: 10_000 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    await updateCommercial({ ads: { unavailableTypes: ['COMPARE_PROMOTION'] } });
    try {
      const r = await call('POST', '/api/seller/advertising/cpc', s.token, { name: 'Compare', adTypes: ['COMPARE_PROMOTION'], productId: s.productId, bidPaise: 500, dailyBudgetPaise: 10_000 });
      expect(r.json.error?.code).toBe('AD_TYPE_UNAVAILABLE');
    } finally {
      await updateCommercial({ ads: { unavailableTypes: [] } });
    }
  });

  it('serves the campaign in a labelled slot for matching searches only', async () => {
    const s = await seller();
    const c = await call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: 'SP', adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 400, dailyBudgetPaise: 10_000 });
    const served = await serveAds('SEARCH', { q: 'kurta' });
    const mine = served.items.find((i) => i.campaignId === c.json.data.id);
    expect(mine?.label).toBe('Sponsored');
    expect(mine?.product.id).toBe(s.productId);
    expect((await serveAds('SEARCH', { q: 'saree' })).items.some((i) => i.campaignId === c.json.data.id)).toBe(false);
  });

  it('charges a valid click once per shopper in 24 hours, from advertising credit first', async () => {
    const s = await seller();
    expect((await call('GET', '/api/seller/advertising', s.token)).status).toBe(200); // welcome credit
    expect((await walletView(s.id)).adCreditPaise).toBe(50_000);
    const c = await call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: 'SP', adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 600, dailyBudgetPaise: 10_000 });
    const u = await shopper();
    const click = { campaignId: c.json.data.id, productId: s.productId, deviceId: 'device-aaaa-1111', slotType: 'SPONSORED_PRODUCT' };
    // Whether a click counted stays on the server.
    expect((await call('POST', '/api/ad-serve/click', u.token, click)).json.data).toEqual({ ok: true });
    expect((await walletView(s.id)).adCreditPaise).toBe(50_000 - 600); // no GST on credit
    // Again within 24 hours — even from another device — counts nothing.
    await call('POST', '/api/ad-serve/click', u.token, { ...click, deviceId: 'device-bbbb-2222' });
    expect((await walletView(s.id)).adCreditPaise).toBe(50_000 - 600);
    // A day later it counts again.
    const later = await registerClick({ ...click, userId: u.id, userAgent: UA, now: new Date(Date.now() + DAY + 60_000) });
    expect(later).toMatchObject({ valid: true, chargedPaise: 600 });
  });

  it('counts a signed-out device once, and never the seller’s own click or a bot', async () => {
    const s = await seller();
    const c = await call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: 'SP', adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 300, dailyBudgetPaise: 10_000 });
    const click = { campaignId: c.json.data.id, productId: s.productId, deviceId: 'device-cccc-3333', slotType: 'SPONSORED_PRODUCT' };
    await call('POST', '/api/ad-serve/click', null, click);
    await call('POST', '/api/ad-serve/click', null, click);
    await call('POST', '/api/ad-serve/click', s.token, { ...click, deviceId: 'device-dddd-4444' });
    await call('POST', '/api/ad-serve/click', null, { ...click, deviceId: 'device-eeee-5555' }, { 'user-agent': 'Googlebot/2.1' });
    const rows = await prisma.adClick.findMany({ where: { campaignId: c.json.data.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.reason)).toEqual([null, 'repeat within 24 hours', 'own click', 'bot']);
    expect(rows.reduce((t, r) => t + r.chargedPaise, 0)).toBe(300);
  });

  it('charges the wallet with GST once the credit is spent, and stops serving at the daily budget', async () => {
    const s = await seller();
    await topUp(s.id, 10_000);
    const c = await call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: 'Budget', adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 1_000, dailyBudgetPaise: 1_000 });
    const u = await shopper();
    await registerClick({ campaignId: c.json.data.id, productId: s.productId, deviceId: 'device-ffff-6666', slotType: 'SPONSORED_PRODUCT', userId: u.id, userAgent: UA });
    expect((await walletView(s.id)).walletPaise).toBe(10_000 - 1_000 - 180);
    const served = await serveAds('SEARCH', { q: 'kurta' });
    expect(served.items.some((i) => i.campaignId === c.json.data.id)).toBe(false);
  });

  // Pre-launch audit (2026-10-20): signed out, a fresh deviceId per click made
  // every click "new", a paused or over-budget campaign was still charged, and
  // once the advertising credit ran out the charges came off the payout.
  it('does not let a signed-out caller drain a seller by inventing a new device id per click', async () => {
    const s = await seller();
    const c = await call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: 'Drain', adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 700, dailyBudgetPaise: 50_000 });
    for (const n of [1, 2, 3, 4, 5]) {
      await call('POST', '/api/ad-serve/click', null, { campaignId: c.json.data.id, productId: s.productId, deviceId: `fresh-device-${n}-${Math.random()}`, slotType: 'SPONSORED_PRODUCT' });
    }
    const rows = await prisma.adClick.findMany({ where: { campaignId: c.json.data.id } });
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.valid)).toHaveLength(1); // one address, one charge a day
    expect(rows.reduce((t, r) => t + r.chargedPaise, 0)).toBe(700);
    expect(new Set(rows.map((r) => r.viewerKey)).size).toBe(1);
    expect(rows[0]!.viewerKey).toMatch(/^ip:[0-9a-f]{32}$/); // hashed, not the raw address
  });

  it('charges nothing for a click on a paused or ended campaign', async () => {
    const s = await seller();
    await topUp(s.id, 100_000);
    const c = await call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: 'Paused', adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 800, dailyBudgetPaise: 50_000 });
    await call('PATCH', `/api/seller/advertising/${c.json.data.id}`, s.token, { status: 'PAUSED' });
    const before = await walletView(s.id);
    const u = await shopper();
    const r = await registerClick({ campaignId: c.json.data.id, productId: s.productId, deviceId: 'device-paused-1', slotType: 'SPONSORED_PRODUCT', userId: u.id, userAgent: UA });
    expect(r).toMatchObject({ valid: false, reason: 'campaign not running', chargedPaise: 0 });
    await prisma.adCampaign.update({ where: { id: c.json.data.id }, data: { status: 'ACTIVE', endAt: new Date(Date.now() - 60_000) } });
    const v = await shopper();
    expect(await registerClick({ campaignId: c.json.data.id, productId: s.productId, deviceId: 'device-ended-1', slotType: 'SPONSORED_PRODUCT', userId: v.id, userAgent: UA })).toMatchObject({ valid: false, chargedPaise: 0 });
    expect(await walletView(s.id)).toEqual(before);
  });

  it('never charges past the daily budget, even for clicks that arrive together', async () => {
    const s = await seller();
    const c = await call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: 'Cap', adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 1_000, dailyBudgetPaise: 3_500 });
    expect((await call('GET', '/api/seller/advertising', s.token)).status).toBe(200); // ₹500 welcome credit
    const shoppers = await Promise.all(Array.from({ length: 8 }, () => shopper()));
    const outcomes = await Promise.all(
      shoppers.map((u, i) => registerClick({ campaignId: c.json.data.id, productId: s.productId, deviceId: `device-cap-${i}`, slotType: 'SPONSORED_PRODUCT', userId: u.id, userAgent: UA })),
    );
    // ₹35 budget, ₹10 bid: three clicks fit, the fourth would pass it.
    expect(outcomes.filter((o) => o.chargedPaise > 0)).toHaveLength(3);
    expect(outcomes.filter((o) => o.reason === 'budget reached')).toHaveLength(5);
    const stats = await prisma.adDailyStat.aggregate({ where: { campaignId: c.json.data.id }, _sum: { spendPaise: true, clicks: true } });
    expect(stats._sum).toEqual({ spendPaise: 3_000, clicks: 3 });
    expect((await walletView(s.id)).adCreditPaise).toBe(50_000 - 3_000);
  });

  it('spends a seller’s advertising credit once when charges arrive together', async () => {
    const s = await seller();
    await postEntry({ sellerId: s.id, type: 'AD_CREDIT_GRANT', bucket: 'AD_CREDIT', amountPaise: 5_000, note: 'test', idempotencyKey: `ad-credit:${s.id}` });
    // Ten campaigns, so no one campaign's lock is what keeps the charges apart.
    const campaigns = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: `Race ${i}`, adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 1_000, dailyBudgetPaise: 50_000 })),
    );
    const shoppers = await Promise.all(campaigns.map(() => shopper()));
    await Promise.all(
      campaigns.map((c, i) => registerClick({ campaignId: c.json.data.id, productId: s.productId, deviceId: `device-race-${i}`, slotType: 'SPONSORED_PRODUCT', userId: shoppers[i]!.id, userAgent: UA })),
    );
    // ₹100 of clicks against ₹50 of credit: the credit ends at exactly zero,
    // and the other ₹50 (+ 18% GST) is charged once, from the payout.
    const w = await walletView(s.id);
    expect(w.adCreditPaise).toBe(0);
    expect(w.settlementPaise).toBe(-(5_000 + 900));
  });

  it('pauses and resumes', async () => {
    const s = await seller();
    const c = await call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: 'Pause', adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 1_100, dailyBudgetPaise: 10_000 });
    await call('PATCH', `/api/seller/advertising/${c.json.data.id}`, s.token, { status: 'PAUSED' });
    expect((await serveAds('SEARCH', { q: 'kurta' })).items.some((i) => i.campaignId === c.json.data.id)).toBe(false);
    await call('PATCH', `/api/seller/advertising/${c.json.data.id}`, s.token, { status: 'ACTIVE', bidPaise: 1_200 });
    expect((await serveAds('SEARCH', { q: 'kurta' })).items.some((i) => i.campaignId === c.json.data.id)).toBe(true);
    expect((await call('PATCH', `/api/seller/advertising/${c.json.data.id}`, s.token, { bidPaise: 5_000 })).json.error?.code).toBe('BID_OUT_OF_RANGE');
  });
});

describe('the placement calendar', () => {
  it('books a day once — advertising and sponsorship share the homepage banner', async () => {
    const a = await seller();
    const b = await seller();
    await topUp(a.id, 500_000);
    await topUp(b.id, 500_000);
    const first = await call<{ id: string; status: string }>('POST', '/api/seller/advertising/placements', a.token, { placement: 'HOMEPAGE_BANNER', startDate: dayStr(10), units: 2, creativeUrl: '/uploads/banner-a.jpg' });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json.data.status).toBe('PENDING_APPROVAL');
    // ₹1,000 a day × 2 + 18% GST, from the welcome-less wallet.
    expect((await walletView(a.id)).walletPaise).toBe(500_000 - 200_000 - 36_000);

    const clash = await call('POST', '/api/seller/advertising/placements', b.token, { placement: 'SP_HOMEPAGE_BANNER', startDate: dayStr(11), units: 1, creativeUrl: '/uploads/banner-b.jpg' });
    expect(clash.json.error?.code).toBe('SLOT_TAKEN');
    expect((await walletView(b.id)).walletPaise).toBe(500_000);
    const free = await call('POST', '/api/seller/advertising/placements', b.token, { placement: 'SP_HOMEPAGE_BANNER', startDate: dayStr(12), units: 1, creativeUrl: '/uploads/banner-b.jpg' });
    expect(free.status).toBe(201);
  });

  it('never double-books when two sellers race for the last slot', async () => {
    const a = await seller();
    const b = await seller();
    const req = (s: { token: string }) => call('POST', '/api/seller/advertising/placements', s.token, { placement: 'CATEGORY_BANNER', categoryId, startDate: dayStr(20), units: 1, creativeUrl: '/uploads/cat.jpg' });
    const results = await Promise.all([req(a), req(b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await prisma.adSlotBooking.count({ where: { space: 'CATEGORY_BANNER', scopeKey: categoryId, day: new Date(`${dayStr(20)}T00:00:00Z`) } })).toBe(1);
  });

  it('a rejected creative frees its days and is refunded; an approved one runs on its day', async () => {
    const a = await seller();
    const b = await seller();
    const adminToken = await admin();
    await topUp(a.id, 300_000);
    const booked = await call<{ id: string }>('POST', '/api/seller/advertising/placements', a.token, { placement: 'HOMEPAGE_BANNER', startDate: dayStr(30), units: 1, creativeUrl: '/uploads/x.jpg' });
    expect((await walletView(a.id)).walletPaise).toBe(300_000 - 118_000);
    const queue = await call<{ id: string }[]>('GET', '/api/admin/ad-review', adminToken);
    expect(queue.json.data.some((r) => r.id === booked.json.data.id)).toBe(true);
    expect((await call('POST', `/api/admin/ad-review/${booked.json.data.id}`, adminToken, { action: 'reject' })).status).toBe(400); // a reason is required
    expect((await call('POST', `/api/admin/ad-review/${booked.json.data.id}`, adminToken, { action: 'reject', reason: 'Text is unreadable' })).status).toBe(200);
    expect((await walletView(a.id)).walletPaise).toBe(300_000);
    expect((await call('POST', `/api/admin/ad-review/${booked.json.data.id}`, adminToken, { action: 'reject', reason: 'Again' })).json.error?.code).toBe('NOT_PENDING');
    expect((await walletView(a.id)).walletPaise).toBe(300_000);

    // The day is free again; today's approved banner is served, labelled.
    const today = await call<{ id: string }>('POST', '/api/seller/advertising/placements', b.token, { placement: 'HOMEPAGE_BANNER', startDate: dayStr(0), units: 1, creativeUrl: '/uploads/today.jpg', headline: 'Diwali edit' });
    expect(today.status, JSON.stringify(today.json)).toBe(201);
    expect((await serveAds('HOME', {})).banners.some((x) => x.campaignId === today.json.data.id)).toBe(false);
    await call('POST', `/api/admin/ad-review/${today.json.data.id}`, adminToken, { action: 'approve' });
    const banner = (await serveAds('HOME', {})).banners.find((x) => x.campaignId === today.json.data.id);
    expect(banner).toMatchObject({ label: 'Ad', headline: 'Diwali edit', creativeUrl: '/uploads/today.jpg' });
    expect((await call('POST', '/api/seller/advertising/placements', b.token, { placement: 'HOMEPAGE_BANNER', startDate: dayStr(30), units: 1, creativeUrl: '/uploads/y.jpg' })).status).toBe(201);
  });

  it('gives Premium sellers the sponsorship discount, and labels sponsorship "Sponsored"', async () => {
    const p = await seller('PREMIUM');
    await topUp(p.id, 100_000);
    const r = await call<{ id: string; pricePaise: number }>('POST', '/api/seller/advertising/placements', p.token, { placement: 'SP_CATEGORY_TOP', categoryId, startDate: dayStr(0), units: 1, productId: p.productId });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.data.pricePaise).toBe(4_950); // ₹99 less 50%
    const served = await serveAds('CATEGORY', { categoryId });
    expect(served.items.find((i) => i.campaignId === r.json.data.id)).toMatchObject({ label: 'Sponsored', slotType: 'SP_CATEGORY_TOP' });
  });

  it('sends Enterprise to vendor support', async () => {
    const s = await seller();
    const r = await call('POST', '/api/seller/advertising/packages', s.token, { package: 'ENTERPRISE', productId: s.productId, startDate: dayStr(0) });
    expect(r.json.error?.code).toBe('CONTACT_SUPPORT');
  });

  it('a package runs its ad types for 7 days, paid up front', async () => {
    const s = await seller();
    await topUp(s.id, 100_000);
    const r = await call<{ id: string; endAt: string; startAt: string }>('POST', '/api/seller/advertising/packages', s.token, { package: 'STARTER', productId: s.productId, startDate: dayStr(0) });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(new Date(r.json.data.endAt).getTime() - new Date(r.json.data.startAt).getTime()).toBe(7 * DAY);
    expect((await walletView(s.id)).walletPaise).toBe(100_000 - 49_900 - 8_982);
  });
});

describe('attribution and metrics', () => {
  it('attributes an order within 7 days of a click, once, and reports CTR and ROAS', async () => {
    const s = await seller();
    const u = await shopper();
    await topUp(s.id, 100_000);
    const c = await call<{ id: string }>('POST', '/api/seller/advertising/cpc', s.token, { name: 'Attr', adTypes: ['SPONSORED_PRODUCT'], productId: s.productId, bidPaise: 500, dailyBudgetPaise: 10_000 });
    await call('POST', '/api/ad-serve/impressions', null, { items: [{ campaignId: c.json.data.id, slotType: 'SPONSORED_PRODUCT' }, { campaignId: c.json.data.id, slotType: 'SPONSORED_PRODUCT' }] });
    await call('POST', '/api/ad-serve/click', u.token, { campaignId: c.json.data.id, productId: s.productId, deviceId: 'device-gggg-7777', slotType: 'SPONSORED_PRODUCT' });
    const order = await prisma.order.create({
      data: { userId: u.id, orderNumber: `CLW-2026-${String(800000 + seq)}`, status: 'CONFIRMED', subtotalPaise: 100_000, shippingPaise: 0, totalPaise: 100_000, shipName: 'Ad Shopper', shipPhone: '9500000000', shipLine1: '1 Test Street', shipCity: 'Mumbai', shipState: 'Maharashtra', shipPincode: '400001' },
    });
    orders.push(order.id);
    await prisma.orderItem.create({ data: { orderId: order.id, productId: s.productId, variantId: s.variantId, sellerId: s.id, title: 'Kurta', size: 'M', color: '', pricePaise: 100_000, quantity: 1, status: 'CONFIRMED' } });
    expect(await attributeOrder(order.id)).toBe(1);
    expect(await attributeOrder(order.id)).toBe(0);

    const overview = await call<{ campaigns: { id: string; metrics: { impressions: number; clicks: number; ctr: number; orders: number; spendPaise: number; roas: number; avgCpcPaise: number } }[] }>('GET', '/api/seller/advertising?section=advertising', s.token);
    const m = overview.json.data.campaigns.find((x) => x.id === c.json.data.id)!.metrics;
    expect(m).toMatchObject({ impressions: 2, clicks: 1, ctr: 50, orders: 1, spendPaise: 500, avgCpcPaise: 500, roas: 200 });
  });
});
