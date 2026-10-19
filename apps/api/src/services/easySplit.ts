import { computeListingEconomics, normalizeTaxId, type SellerFeesV2 } from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { recordAudit } from './auditService';
import { bankAccountNumberOf } from './bankAccountCrypto';
import { CashfreeEasySplitClient } from './cashfree/easySplitClient';
import { categoryRulesMap } from './categoryRules';
import { economicsRates } from './economicsRates';
import { paymentProvider } from './payments';
import { lineClearsAt, balance } from './sellerLedgerService';
import { getSettings } from './settingsService';

// ---------------------------------------------------------------------------
// Cashfree Easy Split (SETTLEMENT_MODE=easy_split)
//
// Each seller is a Cashfree vendor. A paid order carries every seller's share
// as a vendor split; Cashfree holds it (the account defers vendor settlement
// by EASY_SPLIT_DEFER_DAYS) and Clowe brings the settlement forward once the
// seller's lines in that order are past the hold and their return window.
// Clowe's own account only ever receives Clowe's part.
//
// The seller ledger stays the one record of what Clowe owes a seller: when a
// split line is delivered its share is posted as EASY_SPLIT_SHARE (minus), so
// a Clowe payout only ever moves the difference — freight, penalties, a fee
// that changed. Nothing can be paid both ways.
//
// An order is split only when it can be done cleanly; otherwise it is
// collected into Clowe's account and paid by Payouts, as in 'payouts' mode:
//   - more than EASY_SPLIT_MAX_VENDORS sellers
//   - a seller without an ACTIVE vendor
//   - a seller who owes Clowe (negative balance): their next sale settles it
//   - shares that would exceed what the buyer actually pays (credits/coupons)
// ---------------------------------------------------------------------------

/** Cashfree splits one payment across at most five vendors. */
export const EASY_SPLIT_MAX_VENDORS = 5;
/** Must match the dashboard's "Defer settlement by N days" (Cashfree allows up to 45). */
const DEFER_DAYS = 45;
/** A share not released within the deferral settles to Clowe; wait a day past it before treating it so. */
const LAPSE_MARGIN_DAYS = 1;

export function easySplitActive(): boolean {
  return env.SETTLEMENT_MODE === 'easy_split' && paymentProvider.name === 'cashfree';
}

let client: CashfreeEasySplitClient | null = null;
/** The Easy Split client (PG keys); a test can stand a fake one in. */
export function easySplitClient(): CashfreeEasySplitClient {
  if (!client) {
    if (!env.CASHFREE_PG_CLIENT_ID || !env.CASHFREE_PG_CLIENT_SECRET) throw new Error('Easy Split needs the Cashfree PG keys');
    client = new CashfreeEasySplitClient({
      clientId: env.CASHFREE_PG_CLIENT_ID,
      clientSecret: env.CASHFREE_PG_CLIENT_SECRET,
      environment: env.CASHFREE_PG_ENV,
    });
  }
  return client;
}
export function setEasySplitClientForTests(c: CashfreeEasySplitClient | null): void {
  if (env.NODE_ENV !== 'test') throw new Error('setEasySplitClientForTests is for tests only');
  client = c;
}
/** Tests only: pretend SETTLEMENT_MODE=easy_split. */
let forcedActive = false;
export function setEasySplitActiveForTests(on: boolean): void {
  if (env.NODE_ENV !== 'test') throw new Error('setEasySplitActiveForTests is for tests only');
  forcedActive = on;
}
const active = () => forcedActive || easySplitActive();

/** Cashfree's vendor_id for a seller: letters, digits, underscore. */
export function vendorIdFor(sellerId: string): string {
  return `CLW_${sellerId}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50);
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

/**
 * Create (or refresh the status of) a seller's vendor. Only for an approved
 * seller whose PAN and bank account are verified — the same bar a payout has.
 */
export async function ensureVendor(sellerId: string): Promise<string | null> {
  const seller = await prisma.sellerProfile.findUnique({
    where: { id: sellerId },
    select: {
      id: true,
      status: true,
      shopName: true,
      panNumber: true,
      panName: true,
      gstNumber: true,
      bankAccountNo: true,
      bankAccountEnc: true,
      bankIfsc: true,
      bankAccountName: true,
      cashfreeVendorId: true,
      user: { select: { phone: true, email: true } },
    },
  });
  if (!seller || seller.status !== 'APPROVED') return null;
  const c = easySplitClient();
  if (seller.cashfreeVendorId) {
    const status = await c.vendorStatus(seller.cashfreeVendorId);
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { cashfreeVendorStatus: status, cashfreeVendorSyncedAt: new Date() } });
    return status;
  }
  const { getSellerKycSummary } = await import('./kyc/sellerKyc');
  const kyc = await getSellerKycSummary(sellerId);
  if (kyc.pan.state !== 'VERIFIED' || kyc.bank.state !== 'VERIFIED') return null;
  const accountNumber = bankAccountNumberOf(seller);
  const email = seller.user.email;
  if (!accountNumber || !seller.bankIfsc || !seller.panNumber || !email) return null;
  const vendorId = vendorIdFor(sellerId);
  const gstin = seller.gstNumber?.trim() && kyc.gstin.state === 'VERIFIED' ? normalizeTaxId(seller.gstNumber) : null;
  const status = await c.createVendor({
    vendorId,
    name: (seller.bankAccountName || seller.panName || seller.shopName).replace(/[^A-Za-z0-9 .&/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100),
    email,
    phone: seller.user.phone,
    bank: { accountNumber, accountHolder: seller.bankAccountName ?? seller.shopName, ifsc: normalizeTaxId(seller.bankIfsc) },
    pan: normalizeTaxId(seller.panNumber),
    gstin,
    accountType: gstin ? 'BUSINESS' : 'INDIVIDUAL',
    businessType: 'E-commerce',
  });
  await prisma.sellerProfile.update({
    where: { id: sellerId },
    data: { cashfreeVendorId: vendorId, cashfreeVendorStatus: status, cashfreeVendorSyncedAt: new Date() },
  });
  await recordAudit({
    actorRole: 'SYSTEM',
    module: 'PAYOUTS',
    action: 'Easy Split vendor created',
    entityType: 'SellerProfile',
    entityId: sellerId,
    summary: `${seller.shopName}: Cashfree vendor ${vendorId} (${status})`,
    severity: 'MEDIUM',
  });
  return status;
}

/** Create vendors for sellers who qualify and have none; refresh those not ACTIVE yet. */
export async function syncVendors(): Promise<{ created: number; refreshed: number }> {
  if (!active()) return { created: 0, refreshed: 0 };
  let created = 0;
  let refreshed = 0;
  const sellers = await prisma.sellerProfile.findMany({
    where: { status: 'APPROVED', OR: [{ cashfreeVendorId: null }, { NOT: { cashfreeVendorStatus: 'ACTIVE' } }] },
    select: { id: true, cashfreeVendorId: true },
    take: 50,
  });
  for (const s of sellers) {
    try {
      const status = await ensureVendor(s.id);
      if (status && !s.cashfreeVendorId) created += 1;
      else if (status) refreshed += 1;
    } catch (err) {
      console.error(`[clowe-api] Easy Split vendor ${s.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { created, refreshed };
}

// ---------------------------------------------------------------------------
// Checkout: the shares
// ---------------------------------------------------------------------------

export interface SplitPlan {
  /** Per seller, what goes to their vendor. */
  splits: { sellerId: string; vendorId: string; amountPaise: number }[];
  /** Per order line, its part of its seller's share. */
  lines: Map<string, number>;
}

/**
 * The vendor shares for a new order, or null to collect it into Clowe's
 * account. A line's share is what the seller receives for it — the price less
 * Clowe's fees and their GST, TDS and TCS — from the same calculator and the
 * same fee snapshot the ledger will post at delivery.
 */
export async function planSplits(orderId: string): Promise<SplitPlan | null> {
  if (!active()) return null;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      totalPaise: true,
      items: {
        select: {
          id: true,
          sellerId: true,
          pricePaise: true,
          quantity: true,
          gstRatePercent: true,
          feeModel: true,
          feeRates: true,
          product: { select: { categoryId: true } },
        },
      },
    },
  });
  if (!order || order.items.length === 0) return null;
  const sellerIds = [...new Set(order.items.map((i) => i.sellerId))];
  if (sellerIds.length > EASY_SPLIT_MAX_VENDORS) return null;
  const sellers = await prisma.sellerProfile.findMany({
    where: { id: { in: sellerIds } },
    select: { id: true, cashfreeVendorId: true, cashfreeVendorStatus: true },
  });
  if (sellers.length !== sellerIds.length) return null;
  if (sellers.some((s) => !s.cashfreeVendorId || s.cashfreeVendorStatus !== 'ACTIVE')) return null;
  for (const s of sellers) if ((await balance(s.id, 'SETTLEMENT')) < 0) return null;

  const settings = await getSettings();
  const rules = await categoryRulesMap(order.items.map((i) => i.product.categoryId));
  const lines = new Map<string, number>();
  const bySeller = new Map<string, number>();
  for (const item of order.items) {
    const v2 = item.feeModel === 2 && item.feeRates ? (item.feeRates as unknown as SellerFeesV2) : null;
    const e = computeListingEconomics({
      buyerPricePaise: item.pricePaise,
      gstRatePercent: item.gstRatePercent,
      quantity: item.quantity,
      rates: { ...economicsRates(settings), v2 },
      taxRules: rules.get(item.product.categoryId),
    });
    if (e.sellerReceivesPaise <= 0) return null;
    lines.set(item.id, e.sellerReceivesPaise);
    bySeller.set(item.sellerId, (bySeller.get(item.sellerId) ?? 0) + e.sellerReceivesPaise);
  }
  const total = [...bySeller.values()].reduce((a, b) => a + b, 0);
  // Discounts Clowe funds (credits, coupons) can leave less collected than the
  // sellers are owed: then Clowe tops it up from its own account, by payout.
  if (total > order.totalPaise) return null;
  return {
    splits: sellers.map((s) => ({ sellerId: s.id, vendorId: s.cashfreeVendorId!, amountPaise: bySeller.get(s.id)! })),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Releasing shares after the hold
// ---------------------------------------------------------------------------

const TERMINAL_NOT_SOLD = new Set(['CANCELLED', 'RETURNED', 'RTO_DELIVERED']);

/**
 * Bring forward the settlement of every held share whose seller's lines in
 * that order are all done: delivered and past the hold and return window, or
 * cancelled / returned. A share whose deferral ran out first has settled to
 * Clowe instead; it is marked LAPSED and its ledger entries reversed, so the
 * seller is paid by payout.
 */
export async function releaseDueSplits(now: Date = new Date()): Promise<{ released: number; lapsed: number }> {
  if (!active()) return { released: 0, lapsed: 0 };
  const settings = await getSettings();
  const rule = { holdDays: settings.payoutHoldDays, defaultWindowDays: settings.returnWindowDays };
  const held = await prisma.paymentSplit.findMany({
    where: { status: 'HELD', payment: { status: { in: ['PAID', 'REFUNDED'] } } },
    include: {
      payment: {
        select: {
          paidAt: true,
          providerOrderId: true,
          order: { select: { orderNumber: true, items: { select: { id: true, sellerId: true, status: true, deliveredAt: true, returnWindowDays: true } } } },
        },
      },
    },
    take: 200,
  });
  let released = 0;
  let lapsed = 0;
  for (const split of held) {
    try {
      const paidAt = split.payment.paidAt ?? split.createdAt;
      if (now.getTime() > paidAt.getTime() + (DEFER_DAYS + LAPSE_MARGIN_DAYS) * 86400000) {
        await lapseSplit(split.id, split.sellerId, split.payment.order.orderNumber);
        lapsed += 1;
        continue;
      }
      if (split.refundedPaise >= split.amountPaise) {
        await prisma.paymentSplit.update({ where: { id: split.id }, data: { status: 'CLAWED_BACK' } });
        continue;
      }
      const lines = split.payment.order.items.filter((i) => i.sellerId === split.sellerId);
      const done = lines.every(
        (i) =>
          TERMINAL_NOT_SOLD.has(i.status) ||
          (i.status === 'DELIVERED' && i.deliveredAt !== null && lineClearsAt(i.deliveredAt, i.returnWindowDays, rule).getTime() <= now.getTime()),
      );
      if (!done || !split.payment.providerOrderId) continue;
      await easySplitClient().release(split.payment.providerOrderId, split.vendorId, now);
      await prisma.paymentSplit.update({ where: { id: split.id }, data: { status: 'RELEASED', releasedAt: now } });
      released += 1;
    } catch (err) {
      console.error(`[clowe-api] Easy Split release ${split.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { released, lapsed };
}

/** The deferral ran out before release: Cashfree settled the share to Clowe, so Clowe pays it. */
async function lapseSplit(splitId: string, sellerId: string, orderNumber: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.paymentSplit.updateMany({ where: { id: splitId, status: 'HELD' }, data: { status: 'LAPSED' } });
    if (claim.count === 0) return;
    const posted = await tx.sellerLedgerEntry.aggregate({
      where: { sellerId, type: 'EASY_SPLIT_SHARE', orderItem: { order: { payment: { splits: { some: { id: splitId } } } } } },
      _sum: { amountPaise: true },
    });
    const back = -(posted._sum.amountPaise ?? 0);
    if (back > 0) {
      await tx.sellerLedgerEntry.create({
        data: {
          sellerId,
          type: 'ADJUSTMENT',
          bucket: 'SETTLEMENT',
          amountPaise: back,
          idempotencyKey: `easy-split-lapsed:${splitId}`,
          note: `${orderNumber}: your share is paid by Clowe instead of Cashfree`,
        },
      });
    }
  });
  await recordAudit({
    actorRole: 'SYSTEM',
    module: 'PAYOUTS',
    action: 'Easy Split share lapsed',
    entityType: 'PaymentSplit',
    entityId: splitId,
    summary: `${orderNumber}: vendor share not released within ${DEFER_DAYS} days — settled to Clowe, paid by payout`,
    severity: 'HIGH',
  });
}

/** Cashfree settled a vendor: its released shares are paid. From the vendor settlement webhook. */
export async function markVendorSettled(vendorId: string, utr: string | null, at: Date = new Date()): Promise<number> {
  const r = await prisma.paymentSplit.updateMany({
    where: { vendorId, status: 'RELEASED', releasedAt: { lte: at } },
    data: { status: 'SETTLED', settledAt: at, utr },
  });
  return r.count;
}

// ---------------------------------------------------------------------------
// Refunds: the vendor's part comes back from the vendor
// ---------------------------------------------------------------------------

interface StoredSplit {
  sellerId: string;
  vendorId: string;
  amountPaise: number;
}

/**
 * What a refund takes back from each vendor share: the shares of the lines it
 * refunds (a return's line; the order's cancelled or returned lines), less
 * what earlier refunds already took, capped by the refund itself. Anything
 * else (a goodwill refund) comes from Clowe's part alone — which needs the
 * dashboard's "debit vendors in proportion" refund default turned off, or
 * Cashfree spreads an unsplit refund across the vendors itself.
 * Fixed on the refund when sent, so success and failure apply the same split.
 */
export async function refundSplitsFor(refundId: string): Promise<{ vendorId: string; amountPaise: number }[]> {
  const refund = await prisma.refund.findUniqueOrThrow({
    where: { id: refundId },
    select: {
      amountPaise: true,
      vendorSplits: true,
      return: { select: { orderItemId: true } },
      order: {
        select: {
          items: { select: { id: true, sellerId: true, status: true, easySplitPaise: true } },
          payment: { select: { splits: true } },
        },
      },
    },
  });
  const splits = refund.order.payment?.splits ?? [];
  if (splits.length === 0) return [];
  const sendable = (list: StoredSplit[]) =>
    list.filter((s) => s.amountPaise > 0).map((s) => ({ vendorId: s.vendorId, amountPaise: s.amountPaise }));
  if (Array.isArray(refund.vendorSplits)) return sendable(refund.vendorSplits as unknown as StoredSplit[]);
  const items = refund.order.items;
  const owed = new Map<string, number>();
  const lines = refund.return
    ? items.filter((i) => i.id === refund.return!.orderItemId)
    : items.filter((i) => TERMINAL_NOT_SOLD.has(i.status));
  for (const i of lines) owed.set(i.sellerId, (owed.get(i.sellerId) ?? 0) + (i.easySplitPaise ?? 0));

  let left = refund.amountPaise;
  const out: StoredSplit[] = splits.map((s) => {
    const remaining = Math.max(0, s.amountPaise - s.refundedPaise);
    // A return's own line: take its share. Otherwise: what the sold-no-more
    // lines' shares still owe beyond what was already taken back.
    const due = refund.return ? (owed.get(s.sellerId) ?? 0) : Math.max(0, (owed.get(s.sellerId) ?? 0) - s.refundedPaise);
    const take = Math.min(remaining, due, left);
    left -= take;
    return { sellerId: s.sellerId, vendorId: s.vendorId, amountPaise: take };
  });
  await prisma.refund.update({ where: { id: refundId }, data: { vendorSplits: out as unknown as object } });
  return sendable(out);
}

/** A refund succeeded: what it took from each vendor share is recorded against it. */
export async function noteSplitRefund(refundId: string): Promise<void> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: { vendorSplits: true, order: { select: { payment: { select: { id: true } } } } },
  });
  const paymentId = refund?.order.payment?.id;
  if (!paymentId || !Array.isArray(refund.vendorSplits)) return;
  for (const s of refund.vendorSplits as unknown as StoredSplit[]) {
    if (s.amountPaise <= 0) continue;
    await prisma.paymentSplit.updateMany({
      where: { paymentId, sellerId: s.sellerId },
      data: { refundedPaise: { increment: s.amountPaise } },
    });
  }
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export function startEasySplitJobs(): () => void {
  if (!easySplitActive()) return () => undefined;
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    Promise.resolve()
      .then(async () => {
        const v = await syncVendors();
        const r = await releaseDueSplits();
        if (v.created + r.released + r.lapsed > 0) {
          console.log(`[clowe-api] Easy Split: ${v.created} vendors created, ${r.released} shares released, ${r.lapsed} lapsed`);
        }
      })
      .catch((err) => console.error('[clowe-api] Easy Split job failed:', err))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
