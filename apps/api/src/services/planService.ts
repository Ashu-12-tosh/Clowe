import type { SellerPlanKind } from '@prisma/client';
import { cloweGst, planAllows, SELLER_PLANS, type PlanFeature, type SellerPlan } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { getCommercial } from './commercial';
import { sendToUserSafe } from './messaging';
import { balance } from './sellerLedgerService';
import { chargeSeller, grantAdCredit } from './wallet';

// ---------------------------------------------------------------------------
// Seller plans (owner's Batch 2). Monthly and auto-renewing on the same date;
// paid from the Seller Wallet first, then the next payout. Upgrades take
// effect at once, charged for the rest of the month (prorated); downgrades
// wait for the renewal. If a renewal cannot be paid there are graceDays, then
// the plan drops to FREE. Over a plan's live-product limit the seller picks
// which stay live; until they do, the newest stay and the rest are hidden —
// never deleted. Sellers from before the plans get limitGraceUntil.
// ---------------------------------------------------------------------------

const RANK: Record<SellerPlan, number> = { FREE: 0, GROWTH: 1, PRO: 2, PREMIUM: 3 };
const DAY = 86_400_000;

/** One calendar month on, on the same date (clamped to the month's end). */
export function addMonth(from: Date): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export async function ensureSubscription(sellerId: string) {
  return prisma.sellerSubscription.upsert({ where: { sellerId }, update: {}, create: { sellerId } });
}

export async function planOf(sellerId: string): Promise<SellerPlan> {
  return (await prisma.sellerSubscription.findUnique({ where: { sellerId }, select: { plan: true } }))?.plan ?? 'FREE';
}

/** Whether the seller's plan includes a feature; throws PLAN_REQUIRED when not. */
export async function requirePlanFeature(sellerId: string, feature: PlanFeature): Promise<void> {
  const [plan, c] = await Promise.all([planOf(sellerId), getCommercial()]);
  if (planAllows(c, plan, feature)) return;
  const needed = SELLER_PLANS.find((p) => planAllows(c, p, feature));
  throw ApiError.forbidden(`This needs the ${needed ?? 'a higher'} plan — see Plans in your seller dashboard`, 'PLAN_REQUIRED');
}

async function notify(sellerId: string, title: string, body: string, sms = false): Promise<void> {
  const seller = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { userId: true, user: { select: { phone: true } } } });
  if (!seller) return;
  await prisma.notification.create({ data: { userId: seller.userId, type: 'SELLER_PLAN', title, body, linkHref: '/seller/plans' } });
  if (sms) sendToUserSafe(seller.userId, { channel: 'sms', to: `+91${seller.user.phone}`, body: `Clowe: ${title}. ${body}` }, { critical: true });
}

/** Can the wallet plus what is owed on the next payout cover this, GST included? */
async function canPay(sellerId: string, basePaise: number): Promise<boolean> {
  const { fees } = await getCommercial();
  const [wallet, settlement] = await Promise.all([balance(sellerId, 'PROMOTION'), balance(sellerId, 'SETTLEMENT')]);
  return wallet + Math.max(0, settlement) >= basePaise + cloweGst(basePaise, fees.gstPercent);
}

/** Live products over the plan's limit: keep the seller's picks, else the newest; hide the rest. */
export async function enforceProductLimit(sellerId: string, now: Date = new Date()): Promise<{ hidden: number; shown: number }> {
  const sub = await ensureSubscription(sellerId);
  const c = await getCommercial();
  const limit = c.plans[sub.plan].maxLiveProducts;
  const candidates = await prisma.product.findMany({
    where: { sellerId, status: 'APPROVED', isVisible: true },
    orderBy: [{ planHidden: 'asc' }, { createdAt: 'desc' }],
    select: { id: true, planHidden: true },
  });
  const withinGrace = !!sub.limitGraceUntil && sub.limitGraceUntil > now;
  if (limit === null || withinGrace || candidates.length <= limit) {
    const back = await prisma.product.updateMany({ where: { sellerId, planHidden: true }, data: { planHidden: false } });
    return { hidden: 0, shown: back.count };
  }
  // Those live now (the seller's picks, newest first) stay, up to the limit.
  const keep = candidates.slice(0, limit).map((p) => p.id);
  const hide = await prisma.product.updateMany({ where: { sellerId, status: 'APPROVED', isVisible: true, id: { notIn: keep }, planHidden: false }, data: { planHidden: true } });
  const show = await prisma.product.updateMany({ where: { id: { in: keep }, planHidden: true }, data: { planHidden: false } });
  if (hide.count > 0) {
    await notify(
      sellerId,
      `${hide.count} product${hide.count === 1 ? '' : 's'} hidden over your plan's limit`,
      `Your ${sub.plan} plan keeps ${limit} products live. The newest stay live and the rest are hidden, not deleted — choose which stay live in Plans, or upgrade.`,
    );
  }
  return { hidden: hide.count, shown: show.count };
}

/**
 * A product just made live (approved, or switched on): if the seller is
 * already at the plan's limit it waits, hidden, so the seller's own picks
 * stay as they are. Returns whether it is live.
 */
export async function admitToPlan(productId: string, now: Date = new Date()): Promise<boolean> {
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { sellerId: true } });
  if (!p) return false;
  const sub = await ensureSubscription(p.sellerId);
  const limit = (await getCommercial()).plans[sub.plan].maxLiveProducts;
  if (limit === null || (sub.limitGraceUntil && sub.limitGraceUntil > now)) {
    await prisma.product.update({ where: { id: productId }, data: { planHidden: false } });
    return true;
  }
  const live = await prisma.product.count({ where: { sellerId: p.sellerId, status: 'APPROVED', isVisible: true, planHidden: false, id: { not: productId } } });
  const over = live >= limit;
  await prisma.product.update({ where: { id: productId }, data: { planHidden: over } });
  if (over) {
    await notify(p.sellerId, 'Over your plan’s product limit', `Your ${sub.plan} plan keeps ${limit} products live, so this one waits hidden. Choose which stay live in Plans, or upgrade.`);
  }
  return !over;
}

/** The seller chooses which products stay live (up to the plan's limit). */
export async function pickLiveProducts(sellerId: string, productIds: string[]): Promise<void> {
  const sub = await ensureSubscription(sellerId);
  const limit = (await getCommercial()).plans[sub.plan].maxLiveProducts;
  if (limit !== null && productIds.length > limit) throw ApiError.badRequest(`Your plan keeps ${limit} products live — pick ${limit} or fewer`, 'OVER_LIMIT');
  const own = await prisma.product.count({ where: { sellerId, id: { in: productIds } } });
  if (own !== productIds.length) throw ApiError.notFound('Product not found');
  await prisma.$transaction([
    prisma.product.updateMany({ where: { sellerId, status: 'APPROVED', isVisible: true, id: { notIn: productIds } }, data: { planHidden: limit !== null } }),
    prisma.product.updateMany({ where: { sellerId, id: { in: productIds } }, data: { planHidden: false } }),
  ]);
}

/** Start a paid month: charge it and give the plan's advertising credit. */
async function startPaidMonth(sellerId: string, plan: SellerPlan, periodStart: Date, chargePaise: number, why: string): Promise<void> {
  const c = await getCommercial();
  const key = `plan:${sellerId}:${plan}:${periodStart.toISOString()}`;
  await chargeSeller({ sellerId, type: 'SUBSCRIPTION_FEE', basePaise: chargePaise, note: `${plan} plan — ${why}`, idempotencyKey: key });
  await grantAdCredit(sellerId, c.plans[plan].monthlyAdCreditPaise, `${plan} plan advertising credit`, `plancredit:${key}`);
}

/**
 * Change plan. Up: at once, charged for the days left in the paid month (a
 * FREE seller starts a new month). Down: at the next renewal.
 */
export async function changePlan(sellerId: string, target: SellerPlan, now: Date = new Date()) {
  const sub = await ensureSubscription(sellerId);
  const c = await getCommercial();
  if (target === sub.plan) {
    // Choosing the current plan again undoes a pending downgrade.
    return prisma.sellerSubscription.update({ where: { sellerId }, data: { pendingPlan: null, autoRenew: true } });
  }
  if (RANK[target] < RANK[sub.plan]) {
    const updated = await prisma.sellerSubscription.update({ where: { sellerId }, data: { pendingPlan: target as SellerPlanKind } });
    await notify(sellerId, `Moving to ${target} on your renewal date`, `You keep ${sub.plan} until ${sub.periodEnd?.toLocaleDateString('en-IN') ?? 'the end of this month'}.`);
    return updated;
  }
  const price = c.plans[target].pricePaise;
  const inPaidMonth = sub.plan !== 'FREE' && sub.periodStart && sub.periodEnd && sub.periodEnd > now;
  let charge: number;
  let periodStart: Date;
  let periodEnd: Date;
  if (inPaidMonth) {
    const total = sub.periodEnd!.getTime() - sub.periodStart!.getTime();
    const left = sub.periodEnd!.getTime() - now.getTime();
    charge = Math.round(((price - c.plans[sub.plan].pricePaise) * left) / total);
    periodStart = sub.periodStart!;
    periodEnd = sub.periodEnd!;
  } else {
    charge = price;
    periodStart = now;
    periodEnd = addMonth(now);
  }
  if (!(await canPay(sellerId, charge))) {
    throw ApiError.badRequest('Top up your Seller Wallet to upgrade — the charge (with GST) is more than your wallet and payable balance', 'INSUFFICIENT_FUNDS');
  }
  await chargeSeller({
    sellerId,
    type: 'SUBSCRIPTION_FEE',
    basePaise: charge,
    note: inPaidMonth ? `Upgrade to ${target} — rest of the month` : `${target} plan — first month`,
    idempotencyKey: `plan:${sellerId}:${target}:${inPaidMonth ? `up:${now.toISOString()}` : periodStart.toISOString()}`,
  });
  await grantAdCredit(sellerId, c.plans[target].monthlyAdCreditPaise - (inPaidMonth ? c.plans[sub.plan].monthlyAdCreditPaise : 0), `${target} plan advertising credit`, `plancredit:${sellerId}:${target}:${periodStart.toISOString()}`);
  const updated = await prisma.sellerSubscription.update({
    where: { sellerId },
    data: { plan: target as SellerPlanKind, periodStart, periodEnd, pendingPlan: null, graceUntil: null, autoRenew: true },
  });
  await enforceProductLimit(sellerId, now);
  await notify(sellerId, `You are on ${target}`, `Renews on ${periodEnd.toLocaleDateString('en-IN')}.`);
  return updated;
}

export async function setAutoRenew(sellerId: string, autoRenew: boolean) {
  await ensureSubscription(sellerId);
  return prisma.sellerSubscription.update({ where: { sellerId }, data: { autoRenew } });
}

async function dropToFree(sellerId: string, now: Date, why: string): Promise<void> {
  await prisma.sellerSubscription.update({
    where: { sellerId },
    data: { plan: 'FREE', periodStart: null, periodEnd: null, pendingPlan: null, graceUntil: null },
  });
  await enforceProductLimit(sellerId, now);
  await notify(sellerId, 'Your plan is now FREE', why, true);
}

/**
 * Renewals due: on the renewal date, charge the next month (or apply a
 * downgrade, or end a cancelled plan). Money short: graceDays, then FREE.
 */
export async function renewDue(now: Date = new Date()): Promise<{ renewed: number; graced: number; dropped: number }> {
  const c = await getCommercial();
  const due = await prisma.sellerSubscription.findMany({ where: { plan: { not: 'FREE' }, periodEnd: { lte: now } } });
  let renewed = 0;
  let graced = 0;
  let dropped = 0;
  for (const sub of due) {
    const next: SellerPlan = sub.pendingPlan ?? sub.plan;
    if (!sub.autoRenew || next === 'FREE') {
      await dropToFree(sub.sellerId, now, sub.autoRenew ? 'Your downgrade took effect on the renewal date.' : 'Auto-renew was off, so the plan ended on its renewal date.');
      dropped += 1;
      continue;
    }
    const price = c.plans[next].pricePaise;
    if (await canPay(sub.sellerId, price)) {
      const periodStart = sub.periodEnd!;
      await startPaidMonth(sub.sellerId, next, periodStart, price, 'monthly renewal');
      await prisma.sellerSubscription.update({
        where: { sellerId: sub.sellerId },
        data: { plan: next as SellerPlanKind, periodStart, periodEnd: addMonth(periodStart), pendingPlan: null, graceUntil: null },
      });
      if (next !== sub.plan) await enforceProductLimit(sub.sellerId, now);
      renewed += 1;
      continue;
    }
    const graceUntil = sub.graceUntil ?? new Date(sub.periodEnd!.getTime() + c.plans.graceDays * DAY);
    if (now >= graceUntil) {
      await dropToFree(sub.sellerId, now, `The renewal could not be paid within ${c.plans.graceDays} days. Top up your wallet and upgrade again anytime.`);
      dropped += 1;
    } else if (!sub.graceUntil) {
      await prisma.sellerSubscription.update({ where: { sellerId: sub.sellerId }, data: { graceUntil } });
      await notify(sub.sellerId, `Top up to keep ${next}`, `Your renewal could not be paid. Top up your Seller Wallet by ${graceUntil.toLocaleDateString('en-IN')}, or the plan moves to FREE.`, true);
      graced += 1;
    }
  }
  return { renewed, graced, dropped };
}

/** Sellers from before the plans: tell those over the FREE limit once; apply the limit when their notice ends. */
export async function limitNoticeSweep(now: Date = new Date()): Promise<number> {
  const c = await getCommercial();
  const limit = c.plans.FREE.maxLiveProducts;
  const subs = await prisma.sellerSubscription.findMany({ where: { plan: 'FREE', limitGraceUntil: { not: null } } });
  let told = 0;
  for (const sub of subs) {
    if (sub.limitGraceUntil! <= now) {
      await enforceProductLimit(sub.sellerId, now);
      await prisma.sellerSubscription.update({ where: { id: sub.id }, data: { limitGraceUntil: null } });
      continue;
    }
    if (sub.limitNoticeSentAt || limit === null) continue;
    const live = await prisma.product.count({ where: { sellerId: sub.sellerId, status: 'APPROVED', isVisible: true } });
    if (live <= limit) continue;
    await notify(
      sub.sellerId,
      `Clowe plans: FREE keeps ${limit} products live`,
      `You have ${live} live. Until ${sub.limitGraceUntil!.toLocaleDateString('en-IN')} all stay live; then choose ${limit} to keep, or upgrade to a plan with more.`,
      true,
    );
    await prisma.sellerSubscription.update({ where: { id: sub.id }, data: { limitNoticeSentAt: now } });
    told += 1;
  }
  return told;
}

export function startPlanJobs(): void {
  const run = () => {
    renewDue()
      .then((r) => {
        if (r.renewed + r.graced + r.dropped > 0) console.log(`[clowe-api] plans: ${r.renewed} renewed, ${r.graced} in grace, ${r.dropped} to FREE`);
      })
      .catch((err) => console.error('[clowe-api] plan renewals failed:', err));
    limitNoticeSweep().catch((err) => console.error('[clowe-api] plan limit notices failed:', err));
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
}
