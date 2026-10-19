import { TRYON_CONSENT_VERSION } from '@clowe/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { updateCommercial } from '../services/commercial';
import { postEntry } from '../services/sellerLedgerService';
import { expireLots, grantFreeCredits, renewPacks, tryOnProfitReport } from '../services/tryonCredits';
import { walletView } from '../services/wallet';
import { TINY_PNG } from '../test/images';
import { signAccessToken } from '../utils/jwt';
import { TEST_SELLER_ADDRESS } from '../test/fixture';

/**
 * AI Try-On credits (owner's Batch 2): one credit per successful image;
 * failures free; a repeat of the same shopper, photo and product within 24
 * hours free; at zero the button goes and the seller is told; packs from the
 * settings, paid from the wallet with GST, once or monthly; credits lapse at
 * the expiry setting; the first approved sellers get free credits; admin adds
 * credits above the biggest pack; the admin sees cost and profit.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
let categoryId: string;
const DAY = 86_400_000;

async function seller(credits = 0) {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91985${String(seq).padStart(5, '0')}`, name: `Tryon Seller ${seq}`, role: Role.SELLER, referralCode: `TRC-${seq}` } });
  const s = await prisma.sellerProfile.create({ data: { ...TEST_SELLER_ADDRESS, userId: user.id, shopName: `Tryon Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() } });
  if (credits) await prisma.$transaction(async (tx) => (await import('../services/tryonCredits')).addLot(s.id, credits, 'ADMIN', 'test', tx));
  const product = await prisma.product.create({
    data: {
      sellerId: s.id,
      categoryId,
      title: `Tryon Kurta ${seq}`,
      slug: `tryon-kurta-${seq}`,
      description: 'Try-on credit test.',
      basePricePaise: 250_000,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
      tryOnEnabled: true,
      images: { create: [{ url: '/uploads/none.jpg', sortOrder: 0 }] },
    },
  });
  return { id: s.id, userId: user.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }), productId: product.id, slug: product.slug };
}
async function shopper() {
  seq += 1;
  const u = await prisma.user.create({
    data: { phone: `91986${String(seq).padStart(5, '0')}`, name: `Tryon Shopper ${seq}`, referralCode: `TRU-${seq}`, tryOnConsentAt: new Date(), tryOnConsentVersion: TRYON_CONSENT_VERSION },
  });
  const token = signAccessToken({ sub: u.id, role: 'CUSTOMER' });
  const form = new FormData();
  form.append('purpose', 'TRYON_PHOTO');
  form.append('images', new Blob([TINY_PNG], { type: 'image/png' }), 'me.png');
  const up = await fetch(`${base}/api/uploads/private`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const photoRef = ((await up.json()) as { data: { items: { ref: string }[] } }).data.items[0]!.ref;
  return { id: u.id, token, photoRef };
}
async function call<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}
const run = (u: { token: string; photoRef: string }, productId: string) => call<{ status: string }>('POST', '/api/tryon', u.token, { productId, photoRef: u.photoRef });
const credits = async (sellerId: string) => (await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } })).tryOnCredits;
const topUp = (sellerId: string, paise: number) =>
  postEntry({ sellerId, type: 'PROMOTION_CREDIT_PURCHASE', bucket: 'PROMOTION', amountPaise: paise, note: 'test', idempotencyKey: `tryon-topup:${sellerId}:${Math.random()}` });

beforeAll(async () => {
  categoryId = (await prisma.category.create({ data: { name: 'Tryon Kurtas', slug: 'tryon-kurtas', isActive: true, tryOnEligible: true } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a run', () => {
  // Pre-launch audit (2026-10-20), D3: every result carries a visible
  // watermark (the account and the time), burned into the stored image, and
  // is shown only through a link that dies in two minutes.
  it('stores only a watermarked copy of the result, behind a two-minute link', async () => {
    const s = await seller(2);
    const u = await shopper();
    const r = await call<{ status: string; id: string; resultImageUrl: string }>('POST', '/api/tryon', u.token, { productId: s.productId, photoRef: u.photoRef });
    expect(r.json.data.status, JSON.stringify(r.json)).toBe('SUCCESS');

    const row = await prisma.tryOnHistory.findUniqueOrThrow({ where: { id: r.json.data.id } });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: row.resultImageUrl!.replace(/^asset:/, '') } });
    expect(asset).toMatchObject({ purpose: 'TRYON_RESULT', contentType: 'image/jpeg', ownerId: u.id });

    const link = new URL(r.json.data.resultImageUrl);
    const expires = Number(link.searchParams.get('e'));
    expect(expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120);
    // The link names the public API host; this test's server answers the same path.
    const img = await fetch(`${base}${link.pathname}${link.search}`);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await img.arrayBuffer());

    // The watermark is in the pixels: the mock's own picture, re-rendered
    // the same way without it, differs from what was stored.
    const sharp = (await import('sharp')).default;
    const { MockTryOnProvider } = await import('../services/tryon/MockTryOnProvider');
    const raw = await new MockTryOnProvider().generate({ personImageUrl: u.photoRef, garmentImageUrl: '/uploads/none.jpg', productTitle: `Tryon Kurta ${seq}` });
    const plain = await sharp(raw.body).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
    const stored = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    expect([stored.info.width, stored.info.height]).toEqual([plain.info.width, plain.info.height]);
    let differing = 0;
    for (let i = 0; i < plain.data.length; i += 4 * 37) if (Math.abs(plain.data[i]! - stored.data[i]!) > 24) differing += 1;
    expect(differing).toBeGreaterThan(50);
  });

  it('costs one credit; a repeat of the same photo and product within 24 hours is free', async () => {
    const s = await seller(5);
    const u = await shopper();
    const first = await run(u, s.productId);
    expect(first.json.data?.status, JSON.stringify(first.json)).toBe('SUCCESS');
    expect(await credits(s.id)).toBe(4);
    expect((await run(u, s.productId)).json.data.status).toBe('SUCCESS');
    expect(await credits(s.id)).toBe(4);
    // Another shopper is a new image, and a new credit.
    const v = await shopper();
    await run(v, s.productId);
    expect(await credits(s.id)).toBe(3);
  });

  it('at zero hides the button, refuses the run, and tells the seller once', async () => {
    const s = await seller(1);
    const u = await shopper();
    const pdp = async () => (await call<{ tryOnEligible: boolean }>('GET', `/api/products/${s.slug}`, u.token)).json.data.tryOnEligible;
    expect(await pdp()).toBe(true);
    await run(u, s.productId);
    expect(await credits(s.id)).toBe(0);
    expect(await pdp()).toBe(false);
    const v = await shopper();
    expect((await run(v, s.productId)).json.error?.code).toBe('TRYON_NOT_ELIGIBLE');
    // The same shopper's repeat is still free and still runs.
    expect((await run(u, s.productId)).json.data.status).toBe('SUCCESS');
    await expect.poll(() => prisma.notification.count({ where: { userId: s.userId, type: 'SELLER_TRYON' } })).toBe(1);
  });
});

describe('packs', () => {
  it('buys a pack from the wallet with GST, and renews it monthly on the same date', async () => {
    const s = await seller();
    await topUp(s.id, 500_000);
    const r = await call<{ balance: number; renewsAt: string }>('POST', '/api/seller/tryon/buy', s.token, { credits: 100, autoRenew: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.balance).toBe(100);
    expect((await walletView(s.id)).walletPaise).toBe(500_000 - 150_000 - 27_000);
    const renewAt = new Date(r.json.data.renewsAt);
    expect(await renewPacks(new Date(renewAt.getTime() + 60_000))).toMatchObject({ renewed: 1 });
    expect(await renewPacks(new Date(renewAt.getTime() + 120_000))).toMatchObject({ renewed: 0 });
    expect(await credits(s.id)).toBe(200);
    expect((await walletView(s.id)).walletPaise).toBe(500_000 - 2 * 177_000);
  });

  it('refuses a pack that is not on sale, and one the wallet cannot cover', async () => {
    const s = await seller();
    expect((await call('POST', '/api/seller/tryon/buy', s.token, { credits: 150, autoRenew: false })).json.error?.code).toBe('UNKNOWN_PACK');
    expect((await call('POST', '/api/seller/tryon/buy', s.token, { credits: 500, autoRenew: false })).json.error?.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('stops a monthly pack that cannot be paid after the grace days', async () => {
    const s = await seller();
    await topUp(s.id, 177_000);
    const r = await call<{ renewsAt: string }>('POST', '/api/seller/tryon/buy', s.token, { credits: 100, autoRenew: true });
    const at = new Date(r.json.data.renewsAt).getTime();
    expect(await renewPacks(new Date(at + 60_000))).toMatchObject({ renewed: 0, stopped: 0 });
    expect(await renewPacks(new Date(at + 4 * DAY))).toMatchObject({ stopped: 1 });
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.id } })).tryOnPackRenewCredits).toBeNull();
  });
});

describe('expiry, the free grant, admin credits and the report', () => {
  it('lets unused credits lapse at the expiry setting, oldest-expiring spent first', async () => {
    await updateCommercial({ tryon: { expiryDays: 30 } });
    try {
      const s = await seller(10);
      const u = await shopper();
      await run(u, s.productId);
      expect(await credits(s.id)).toBe(9);
      await expireLots(new Date(Date.now() + 31 * DAY));
      expect(await credits(s.id)).toBe(0);
      const lapsed = await prisma.tryOnCreditLedger.findFirst({ where: { sellerId: s.id, reason: 'EXPIRED' } });
      expect(lapsed?.delta).toBe(-9);
    } finally {
      await updateCommercial({ tryon: { expiryDays: null } });
    }
  });

  it('gives the free credits to the first approved sellers only, once each', async () => {
    const given = await prisma.sellerProfile.count({ where: { tryOnFreeGrant: true, status: 'APPROVED' } });
    await updateCommercial({ tryon: { freeGrantSellers: given + 1 } });
    try {
      const a = await seller();
      const b = await seller();
      expect(await grantFreeCredits(a.id)).toBe(true);
      expect(await grantFreeCredits(a.id)).toBe(false);
      expect(await grantFreeCredits(b.id)).toBe(false);
      expect(await credits(a.id)).toBe(50);
      expect(await credits(b.id)).toBe(0);
    } finally {
      await updateCommercial({ tryon: { freeGrantSellers: 51 } });
    }
  });

  it('admin adds credits above the biggest pack at ₹9 each, or free', async () => {
    seq += 1;
    const admin = await prisma.user.create({ data: { phone: `91987${String(seq).padStart(5, '0')}`, name: 'Tryon Admin', role: Role.ADMIN, referralCode: `TRA-${seq}` } });
    const token = signAccessToken({ sub: admin.id, role: 'ADMIN' });
    const s = await seller();
    await topUp(s.id, 1_000_000);
    expect((await call('POST', `/api/admin/sellers/${s.id}/tryon-credits`, token, { credits: 600, charge: true, note: 'Asked on WhatsApp' })).status).toBe(200);
    expect(await credits(s.id)).toBe(600);
    expect((await walletView(s.id)).walletPaise).toBe(1_000_000 - 540_000 - 97_200);
    await call('POST', `/api/admin/sellers/${s.id}/tryon-credits`, token, { credits: 10, charge: false });
    expect(await credits(s.id)).toBe(610);
    // The audit write does not hold up the response.
    await expect.poll(() => prisma.auditLog.count({ where: { entityId: s.id, action: 'Try-on credits added' } })).toBe(2);

    const month = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7);
    const report = (await call<Awaited<ReturnType<typeof tryOnProfitReport>>>('GET', `/api/admin/tryon/profit?month=${month}`, token)).json.data;
    expect(report.creditsSold).toBeGreaterThanOrEqual(610);
    expect(report.revenuePaise).toBeGreaterThanOrEqual(540_000);
    expect(report.costPerCreditPaise).toBe(732);
    expect(report.profitPaise).toBe(report.revenuePaise - report.successfulRuns * 732);
    // Sellers never see it.
    expect((await call('GET', `/api/admin/tryon/profit?month=${month}`, s.token)).status).toBe(403);
  });
});
