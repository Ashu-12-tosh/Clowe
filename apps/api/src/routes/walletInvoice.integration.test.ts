import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istMonthOf, type SellerMonthlyInvoice } from '@clowe/shared';
import { createApp } from '../app';
import { buildMonthlyInvoice, issueMonthlyInvoice } from '../services/sellerInvoice';
import { postEntry } from '../services/sellerLedgerService';
import { chargeSeller, grantAdCredit, walletView } from '../services/wallet';
import { setSetting } from '../services/settingsService';
import { DEFAULT_SETTINGS } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * The Seller Wallet and Clowe's monthly tax invoice (owner's Batch 2):
 * charges come from advertising credit (ads only, no GST), then the wallet,
 * then the next payout, each with 18% GST beside it; once per key; and the
 * month's invoice lists every charge with CGST + SGST inside Delhi or IGST
 * outside, credits fees reversed on returns, and is numbered once issued.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;

async function seller(gstin: string | null) {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91963${String(seq).padStart(5, '0')}`, name: `Wallet Seller ${seq}`, role: Role.SELLER, referralCode: `WAL-${seq}` } });
  const s = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Wallet Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: gstin, panName: `WALLET TRADERS ${seq}`, addressLine1: '1 Lane', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  });
  return { id: s.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}
const topUp = (sellerId: string, paise: number) =>
  postEntry({ sellerId, type: 'PROMOTION_CREDIT_PURCHASE', bucket: 'PROMOTION', amountPaise: paise, note: 'test top-up', idempotencyKey: `test-topup:${sellerId}:${paise}:${Math.random()}` });

beforeAll(async () => {
  await setSetting('legalEntity', { ...DEFAULT_SETTINGS.legalEntity, gstin: '07AAWFC9519L1ZL', registeredAddress: 'H. No. 22-A, Ground Floor, Pole 43, Surakh Pur Road, Gali No. 21, Najafgarh, New Delhi 110043' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await setSetting('legalEntity', DEFAULT_SETTINGS.legalEntity);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('charging a seller', () => {
  it('takes the wallet first, the rest from the next payout, with 18% GST', async () => {
    const s = await seller('27ABCDE1234F1Z5');
    await topUp(s.id, 30_000); // ₹300
    const r = await chargeSeller({ sellerId: s.id, type: 'SUBSCRIPTION_FEE', basePaise: 59_900, note: 'Growth plan', idempotencyKey: `t1:${s.id}` });
    expect(r).toMatchObject({ charged: true, gstPaise: 10_782, fromWalletPaise: 30_000, fromPayoutPaise: 40_682 });
    const w = await walletView(s.id);
    expect(w.walletPaise).toBe(0);
    expect(w.settlementPaise).toBe(-40_682);
    const gst = await prisma.sellerLedgerEntry.aggregate({ where: { sellerId: s.id, type: 'CLOWE_FEE_GST', chargeType: 'SUBSCRIPTION_FEE' }, _sum: { amountPaise: true } });
    expect(gst._sum.amountPaise).toBe(-10_782);
    // Once per key.
    expect((await chargeSeller({ sellerId: s.id, type: 'SUBSCRIPTION_FEE', basePaise: 59_900, note: 'Growth plan', idempotencyKey: `t1:${s.id}` })).charged).toBe(false);
    expect((await walletView(s.id)).settlementPaise).toBe(-40_682);
  });

  it('spends advertising credit first on ads, with no GST on that part', async () => {
    const s = await seller('27ABCDE1234F1Z5');
    await grantAdCredit(s.id, 50_000, 'Welcome credit', `welcome:${s.id}`);
    await topUp(s.id, 100_000);
    const r = await chargeSeller({ sellerId: s.id, type: 'AD_SPEND', basePaise: 60_000, note: 'Clicks', idempotencyKey: `t2:${s.id}`, useAdCredit: true });
    expect(r).toMatchObject({ fromAdCreditPaise: 50_000, gstPaise: 1_800, fromWalletPaise: 11_800, fromPayoutPaise: 0 });
    expect(await walletView(s.id)).toMatchObject({ adCreditPaise: 0, walletPaise: 88_200 });
  });

  it('refuses a wallet-only purchase the wallet cannot cover, charging nothing', async () => {
    const s = await seller('27ABCDE1234F1Z5');
    await topUp(s.id, 10_000);
    const r = await chargeSeller({ sellerId: s.id, type: 'TRYON_CREDITS', basePaise: 150_000, note: '100 credits', idempotencyKey: `t3:${s.id}`, walletOnly: true });
    expect(r.charged).toBe(false);
    expect((await walletView(s.id)).walletPaise).toBe(10_000);
  });
});

describe('the monthly tax invoice', () => {
  it('lists the month’s charges with IGST for a seller outside Delhi, and credits fees reversed on returns', async () => {
    const s = await seller('27ABCDE1234F1Z5');
    await chargeSeller({ sellerId: s.id, type: 'SUBSCRIPTION_FEE', basePaise: 99_900, note: 'Pro plan', idempotencyKey: `i1:${s.id}` });
    // A delivered line's fees (as the ledger posts them) and its return in the same month.
    await postEntry({ sellerId: s.id, type: 'COMMISSION', bucket: 'SETTLEMENT', amountPaise: -2_000, idempotencyKey: `i1c:${s.id}` });
    await postEntry({ sellerId: s.id, type: 'HANDLING_FEE', bucket: 'SETTLEMENT', amountPaise: -1_900, idempotencyKey: `i1h:${s.id}` });
    await postEntry({ sellerId: s.id, type: 'CLOWE_FEE_GST', bucket: 'SETTLEMENT', amountPaise: -702, chargeType: 'ORDER_FEES', taxablePaise: 3_900, idempotencyKey: `i1g:${s.id}` });
    const doc = await buildMonthlyInvoice(s.id, istMonthOf(new Date()));
    expect(doc.number).toBeNull();
    expect(doc.intraState).toBe(false);
    expect(doc.supplier).toMatchObject({ name: 'CLOWE PARTNERS LLP', gstin: '07AAWFC9519L1ZL' });
    const line = (key: string) => doc.lines.find((l) => l.key === key)!;
    expect(line('SUBSCRIPTION_FEE')).toMatchObject({ taxablePaise: 99_900, igstPaise: 17_982, cgstPaise: 0, totalPaise: 117_882 });
    expect(line('COMMISSION').taxablePaise + line('HANDLING_FEE').taxablePaise).toBe(3_900);
    expect(line('COMMISSION').igstPaise + line('HANDLING_FEE').igstPaise).toBe(702);
    expect(doc.totals.totalPaise).toBe(117_882 + 3_900 + 702);
  });

  it('splits CGST and SGST for a Delhi seller', async () => {
    const s = await seller('07ABCDE1234F1Z9');
    await chargeSeller({ sellerId: s.id, type: 'SPONSORSHIP_FEE', basePaise: 19_900, note: 'Homepage featured', idempotencyKey: `i2:${s.id}` });
    const doc = await buildMonthlyInvoice(s.id, istMonthOf(new Date()));
    expect(doc.intraState).toBe(true);
    expect(doc.lines[0]).toMatchObject({ cgstPaise: 1_791, sgstPaise: 1_791, igstPaise: 0 });
  });

  it('is issued once a month has ended, numbered once, and downloadable', async () => {
    const s = await seller('27ABCDE1234F1Z5');
    const lastMonth = new Date(Date.now() - 40 * 86_400_000);
    await prisma.sellerLedgerEntry.create({ data: { sellerId: s.id, type: 'TRYON_CREDITS', bucket: 'SETTLEMENT', amountPaise: -150_000, createdAt: lastMonth, note: '100 credits' } });
    await prisma.sellerLedgerEntry.create({ data: { sellerId: s.id, type: 'CLOWE_FEE_GST', bucket: 'SETTLEMENT', amountPaise: -27_000, chargeType: 'TRYON_CREDITS', createdAt: lastMonth } });
    const month = istMonthOf(lastMonth);
    expect(await issueMonthlyInvoice(s.id, istMonthOf(new Date())).catch((e: Error) => e.message)).toMatch(/once it has ended/);
    const first = (await issueMonthlyInvoice(s.id, month))!;
    // "CLW/2627/000001": GST's 16 characters at most.
    expect(first.number).toMatch(/^CLW\/\d{4}\/\d{6}$/);
    expect(first.number!.length).toBeLessThanOrEqual(16);
    const again = (await issueMonthlyInvoice(s.id, month))!;
    expect(again.number).toBe(first.number);
    const res = await fetch(`${base}/api/seller/billing/invoices/${month}`, { headers: { authorization: `Bearer ${s.token}` } });
    const body = (await res.json()) as { data: SellerMonthlyInvoice };
    expect(body.data).toMatchObject({ number: first.number, totals: { taxablePaise: 150_000, totalPaise: 177_000 } });
    const list = await fetch(`${base}/api/seller/billing/invoices`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(((await list.json()) as { data: { month: string; number: string }[] }).data.find((r) => r.month === month)?.number).toBe(first.number);
  });
});
