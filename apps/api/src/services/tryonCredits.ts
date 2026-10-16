import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TryOnProfitReport } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { getCommercial } from './commercial';
import { sendToUserSafe } from './messaging';
import { addMonth, canPay } from './planService';
import { chargeSeller } from './wallet';

// ---------------------------------------------------------------------------
// AI Try-On credits (owner's Batch 2). One credit per successful image; a
// failure is free, and so is a repeat of the same shopper, photo and product
// within 24 hours. Credits come in lots — the free grant for the first
// approved sellers, packs (one-time or renewing monthly) paid from the Seller
// Wallet with GST, admin top-ups above the biggest pack — spent oldest-
// expiring first, and what is left of a lot lapses at its expiry (a setting;
// none = never). At zero the Try-On button goes and the seller is told.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
type Tx = Prisma.TransactionClient;

async function tell(sellerId: string, title: string, body: string, sms = false) {
  const seller = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { userId: true, user: { select: { phone: true } } } });
  if (!seller) return;
  await prisma.notification.create({ data: { userId: seller.userId, type: 'SELLER_TRYON', title, body, linkHref: '/seller/tryon' } });
  if (sms) sendToUserSafe(seller.userId, { channel: 'sms', to: `+91${seller.user.phone}`, body: `Clowe: ${title}. ${body}` }, { critical: true });
}

/** Add a lot of credits (with the setting's expiry for packs and grants). */
export async function addLot(
  sellerId: string,
  credits: number,
  source: 'FREE_GRANT' | 'PURCHASE' | 'ADMIN',
  note: string,
  tx: Tx = prisma,
  now: Date = new Date(),
): Promise<void> {
  const { tryon } = await getCommercial();
  const expiresAt = tryon.expiryDays ? new Date(now.getTime() + tryon.expiryDays * DAY) : null;
  await tx.tryOnCreditLot.create({ data: { sellerId, source, credits, remaining: credits, expiresAt, createdAt: now } });
  await tx.sellerProfile.update({
    where: { id: sellerId },
    data: { tryOnCredits: { increment: credits }, tryOnZeroNotifiedAt: null, ...(source === 'FREE_GRANT' ? { tryOnFreeGrant: true } : {}) },
  });
  await tx.tryOnCreditLedger.create({ data: { sellerId, delta: credits, reason: source, note: expiresAt ? `${note} (expire ${expiresAt.toISOString().slice(0, 10)})` : note, createdAt: now } });
}

/** Spend one credit for a successful run. Returns the balance left. */
export async function consumeCredit(sellerId: string, note: string, tx: Tx, now: Date = new Date()): Promise<number> {
  const lot = await tx.tryOnCreditLot.findFirst({
    where: { sellerId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
  });
  if (lot) await tx.tryOnCreditLot.update({ where: { id: lot.id }, data: { remaining: { decrement: 1 } } });
  const p = await tx.sellerProfile.update({ where: { id: sellerId }, data: { tryOnCredits: { decrement: 1 } }, select: { tryOnCredits: true } });
  await tx.tryOnCreditLedger.create({ data: { sellerId, delta: -1, reason: 'RUN', note: note.slice(0, 80), createdAt: now } });
  return p.tryOnCredits;
}

/** At zero: the button is already gone (the product page checks the balance); tell the seller once. */
export async function noticeIfOut(sellerId: string, now: Date = new Date()): Promise<void> {
  const p = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { tryOnCredits: true, tryOnZeroNotifiedAt: true } });
  if (!p || p.tryOnCredits > 0 || p.tryOnZeroNotifiedAt) return;
  await prisma.sellerProfile.update({ where: { id: sellerId }, data: { tryOnZeroNotifiedAt: now } });
  await tell(sellerId, 'AI Try-On credits used up', 'Shoppers no longer see “Try On Me” on your products. Buy a credit pack to turn it back on.', true);
}

/** Lots past their expiry give up what is left. */
export async function expireLots(now: Date = new Date()): Promise<number> {
  const due = await prisma.tryOnCreditLot.findMany({ where: { remaining: { gt: 0 }, expiresAt: { lte: now } } });
  for (const lot of due) {
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.tryOnCreditLot.updateMany({ where: { id: lot.id, remaining: lot.remaining }, data: { remaining: 0 } });
      if (fresh.count === 0) return;
      await tx.sellerProfile.update({ where: { id: lot.sellerId }, data: { tryOnCredits: { decrement: lot.remaining } } });
      await tx.tryOnCreditLedger.create({ data: { sellerId: lot.sellerId, delta: -lot.remaining, reason: 'EXPIRED', note: `${lot.remaining} unused credits expired`, createdAt: now } });
    });
    await noticeIfOut(lot.sellerId, now);
  }
  return due.length;
}

/**
 * The free grant: the first freeGrantSellers approved sellers get
 * freeGrantCredits, once. Sellers approved before it count, and get theirs
 * the first time they open AI Try-On.
 */
export async function grantFreeCredits(sellerId: string): Promise<boolean> {
  const { tryon } = await getCommercial();
  const seller = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { status: true, tryOnFreeGrant: true } });
  if (!seller || seller.status !== 'APPROVED' || seller.tryOnFreeGrant || tryon.freeGrantCredits <= 0) return false;
  return prisma.$transaction(async (tx) => {
    // One grant at a time, so two approvals cannot both take the last place.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7745001)`;
    const given = await tx.sellerProfile.count({ where: { tryOnFreeGrant: true, status: 'APPROVED' } });
    if (given >= tryon.freeGrantSellers) return false;
    const again = await tx.sellerProfile.findUnique({ where: { id: sellerId }, select: { tryOnFreeGrant: true } });
    if (again?.tryOnFreeGrant) return false;
    await addLot(sellerId, tryon.freeGrantCredits, 'FREE_GRANT', `Free credits for the first ${tryon.freeGrantSellers} approved sellers`, tx);
    return true;
  });
}

function packFor(credits: number, packs: { credits: number; pricePaise: number }[]) {
  const pack = packs.find((p) => p.credits === credits);
  if (!pack) throw ApiError.badRequest('Pick one of the credit packs', 'UNKNOWN_PACK');
  return pack;
}

/** Charge and add a pack. */
async function chargePack(sellerId: string, credits: number, pricePaise: number, key: string, note: string, now: Date) {
  await chargeSeller({ sellerId, type: 'TRYON_CREDITS', basePaise: pricePaise, note, idempotencyKey: key });
  await prisma.$transaction((tx) => addLot(sellerId, credits, 'PURCHASE', note, tx, now));
}

/** Buy a pack now; with autoRenew it is bought again every month on this date. */
export async function buyPack(sellerId: string, credits: number, autoRenew: boolean, now: Date = new Date()) {
  const { tryon } = await getCommercial();
  const pack = packFor(credits, tryon.packs);
  if (!(await canPay(sellerId, pack.pricePaise))) {
    throw ApiError.badRequest('Top up your Seller Wallet — the pack (with GST) is more than your wallet and payable balance', 'INSUFFICIENT_FUNDS');
  }
  await chargePack(sellerId, pack.credits, pack.pricePaise, `tryon-pack:${sellerId}:${randomUUID()}`, `AI Try-On ${pack.credits}-credit pack${autoRenew ? ' (monthly)' : ''}`, now);
  if (autoRenew) {
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { tryOnPackRenewCredits: pack.credits, tryOnPackRenewAt: addMonth(now) } });
  }
  return prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { tryOnCredits: true, tryOnPackRenewCredits: true, tryOnPackRenewAt: true } });
}

/** Stop (null) or change the monthly pack; a change applies at the next renewal. */
export async function setPackAutoRenew(sellerId: string, credits: number | null) {
  const { tryon } = await getCommercial();
  if (credits !== null) packFor(credits, tryon.packs);
  const p = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { tryOnPackRenewAt: true } });
  if (credits !== null && !p.tryOnPackRenewAt) throw ApiError.badRequest('Buy a monthly pack first', 'NO_MONTHLY_PACK');
  return prisma.sellerProfile.update({
    where: { id: sellerId },
    data: credits === null ? { tryOnPackRenewCredits: null, tryOnPackRenewAt: null } : { tryOnPackRenewCredits: credits },
    select: { tryOnCredits: true, tryOnPackRenewCredits: true, tryOnPackRenewAt: true },
  });
}

/**
 * Monthly packs due: bought again on the same date. One that cannot be paid
 * is tried again each run for the plans' grace days, then stops.
 */
export async function renewPacks(now: Date = new Date()): Promise<{ renewed: number; stopped: number }> {
  const c = await getCommercial();
  const due = await prisma.sellerProfile.findMany({
    where: { tryOnPackRenewCredits: { not: null }, tryOnPackRenewAt: { lte: now } },
    select: { id: true, tryOnPackRenewCredits: true, tryOnPackRenewAt: true },
  });
  let renewed = 0;
  let stopped = 0;
  for (const s of due) {
    const pack = c.tryon.packs.find((p) => p.credits === s.tryOnPackRenewCredits);
    const at = s.tryOnPackRenewAt!;
    if (pack && (await canPay(s.id, pack.pricePaise))) {
      // Keyed by the renewal date: a second run the same day cannot charge twice.
      await chargePack(s.id, pack.credits, pack.pricePaise, `tryon-renew:${s.id}:${at.toISOString()}`, `AI Try-On ${pack.credits}-credit pack (monthly renewal)`, now);
      await prisma.sellerProfile.update({ where: { id: s.id }, data: { tryOnPackRenewAt: addMonth(at) } });
      renewed += 1;
    } else if (!pack || now.getTime() - at.getTime() > c.plans.graceDays * DAY) {
      await prisma.sellerProfile.update({ where: { id: s.id }, data: { tryOnPackRenewCredits: null, tryOnPackRenewAt: null } });
      await tell(s.id, 'Monthly try-on pack stopped', 'We could not take the payment for your monthly AI Try-On pack, so it has stopped. Top up your Seller Wallet and buy a pack to start again.', true);
      stopped += 1;
    } else if (now.getTime() - at.getTime() < DAY) {
      await tell(s.id, 'Top up for your monthly try-on pack', `Your Seller Wallet cannot pay for this month’s AI Try-On pack. Top up within ${c.plans.graceDays} days or the monthly pack stops.`, true);
    }
  }
  return { renewed, stopped };
}

/** Admin: credits above the biggest pack (asked for through vendor support), charged at the per-credit rate unless waived. */
export async function adminAddCredits(sellerId: string, credits: number, charge: boolean, note: string) {
  const { tryon } = await getCommercial();
  const seller = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { id: true } });
  if (!seller) throw ApiError.notFound('Seller not found');
  const pricePaise = charge ? credits * tryon.extraCreditPaise : 0;
  if (pricePaise > 0) {
    await chargeSeller({ sellerId, type: 'TRYON_CREDITS', basePaise: pricePaise, note: `AI Try-On: ${credits} credits at ₹${tryon.extraCreditPaise / 100} each`, idempotencyKey: `tryon-admin:${sellerId}:${randomUUID()}` });
  }
  await prisma.$transaction((tx) => addLot(sellerId, credits, 'ADMIN', note || `Added by Clowe (${credits} credits)`, tx));
  await tell(sellerId, `${credits} AI Try-On credits added`, pricePaise ? `Charged ₹${(pricePaise / 100).toLocaleString('en-IN')} + GST.` : 'No charge.');
  return { credits, pricePaise };
}

export function startTryOnCreditJobs(): void {
  const run = () =>
    void (async () => {
      await expireLots();
      await renewPacks();
    })().catch((err) => console.error('[clowe-api] try-on credit jobs failed:', err));
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
}

/** Admin only: what credits earned, what the provider cost, for a month (YYYY-MM, India time). */
export async function tryOnProfitReport(month: string): Promise<TryOnProfitReport> {
  const c = await getCommercial();
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, 1) - 5.5 * 3_600_000);
  const to = new Date(Date.UTC(y, m, 1) - 5.5 * 3_600_000);
  const [sold, granted, used, runs, revenue] = await Promise.all([
    prisma.tryOnCreditLot.aggregate({ where: { source: { in: ['PURCHASE', 'ADMIN'] }, createdAt: { gte: from, lt: to } }, _sum: { credits: true } }),
    prisma.tryOnCreditLot.aggregate({ where: { source: 'FREE_GRANT', createdAt: { gte: from, lt: to } }, _sum: { credits: true } }),
    prisma.tryOnCreditLedger.count({ where: { reason: 'RUN', createdAt: { gte: from, lt: to } } }),
    prisma.tryOnHistory.groupBy({ by: ['status'], where: { createdAt: { gte: from, lt: to } }, _count: { _all: true }, _sum: { costPaise: true } }),
    prisma.sellerLedgerEntry.aggregate({ where: { type: 'TRYON_CREDITS', createdAt: { gte: from, lt: to } }, _sum: { amountPaise: true } }),
  ]);
  const by = (s: string) => runs.find((r) => r.status === s);
  const successful = by('SUCCESS')?._count._all ?? 0;
  const failed = by('FAILED')?._count._all ?? 0;
  const providerCostPaise = runs.reduce((t, r) => t + (r._sum.costPaise ?? 0), 0);
  const revenuePaise = -(revenue._sum.amountPaise ?? 0);
  const estimatedCostPaise = successful * c.tryon.costPerCreditPaise;
  return {
    month,
    creditsSold: sold._sum.credits ?? 0,
    creditsGranted: granted._sum.credits ?? 0,
    creditsUsed: used,
    successfulRuns: successful,
    freeRepeats: Math.max(0, successful - used),
    failedRuns: failed,
    revenuePaise,
    providerCostPaise,
    estimatedCostPaise,
    profitPaise: revenuePaise - estimatedCostPaise,
    costPerCreditPaise: c.tryon.costPerCreditPaise,
    tierCostsPaise: c.tryon.tierCostsPaise,
    phaseNote: c.tryon.phaseNote,
  };
}
