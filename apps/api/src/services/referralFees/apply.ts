import { prisma } from '../../db';
import { enqueueEmail } from '../email';
import { invalidateReferralFees } from './index';
import type { ScheduleRate } from './sheet';

// Writing the schedule: a new version (never an edit in place — order lines
// placed under the old one keep its rates), the category mapping, and the
// notice to sellers.

/** Save `rates` as the next version, in force from `effectiveFrom`. */
export async function createScheduleVersion(input: {
  rates: ScheduleRate[];
  source: string;
  effectiveFrom: Date;
  createdById?: string | null;
  note?: string | null;
}): Promise<{ id: string; version: number }> {
  if (input.rates.length === 0) throw new Error('A schedule needs at least one rate');
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('referral-fee-schedule'))`;
    const last = await tx.referralFeeSchedule.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
    const schedule = await tx.referralFeeSchedule.create({
      data: {
        version: (last?.version ?? 0) + 1,
        source: input.source.slice(0, 200),
        effectiveFrom: input.effectiveFrom,
        createdById: input.createdById ?? null,
        note: input.note?.slice(0, 500) ?? null,
      },
    });
    await tx.referralFeeRate.createMany({
      data: input.rates.map((r, position) => ({
        scheduleId: schedule.id,
        group: r.group,
        sheetCategory: r.sheetCategory,
        slabLabel: r.slabLabel,
        abovePaise: r.abovePaise,
        upToPaise: r.upToPaise,
        rateBps: r.rateBps,
        benchmarkBps: r.benchmarkBps,
        borrowedFrom: r.borrowedFrom,
        position,
      })),
    });
    return { id: schedule.id, version: schedule.version };
  });
  invalidateReferralFees();
  return created;
}

/** The rates of a stored version, as a new version would be written. */
export async function ratesOfVersion(version: number): Promise<ScheduleRate[]> {
  const rows = await prisma.referralFeeRate.findMany({ where: { schedule: { version } }, orderBy: { position: 'asc' } });
  return rows.map((r) => ({
    group: r.group,
    sheetCategory: r.sheetCategory,
    slabLabel: r.slabLabel,
    abovePaise: r.abovePaise,
    upToPaise: r.upToPaise,
    rateBps: r.rateBps,
    benchmarkBps: r.benchmarkBps,
    borrowedFrom: r.borrowedFrom,
  }));
}

/** Set categories' schedule categories; returns what each was before. */
export async function applyCategoryMapping(
  entries: { categoryId: string; sheetCategory: string | null }[],
): Promise<{ categoryId: string; before: string | null; after: string | null }[]> {
  const before = await prisma.category.findMany({
    where: { id: { in: entries.map((e) => e.categoryId) } },
    select: { id: true, referralFeeCategory: true },
  });
  const was = new Map(before.map((b) => [b.id, b.referralFeeCategory]));
  await prisma.$transaction(
    entries.map((e) => prisma.category.update({ where: { id: e.categoryId }, data: { referralFeeCategory: e.sheetCategory } })),
  );
  invalidateReferralFees();
  return entries.map((e) => ({ categoryId: e.categoryId, before: was.get(e.categoryId) ?? null, after: e.sheetCategory }));
}

const istDate = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Tell every seller (bell and email, once per version): referral fees now go
 * by category and price slab, from when, and where to see their rates.
 */
export async function notifySellersOfSchedule(version: number): Promise<{ notified: number; emailed: number }> {
  const schedule = await prisma.referralFeeSchedule.findUniqueOrThrow({ where: { version } });
  const sellers = await prisma.sellerProfile.findMany({
    where: { status: { in: ['APPROVED', 'PENDING'] } },
    select: { id: true, userId: true, shopName: true, storeEmail: true, user: { select: { email: true } } },
  });
  const from = istDate(schedule.effectiveFrom);
  const title = 'Referral fees now go by category and price';
  const body = `From ${from}, the referral fee on a sale is the rate for your product's category and its selling price slab, applied to the whole price. Orders placed before then keep the fees they were placed under. The product form shows the fee for each price, and the Seller Terms (updated) and the Referral Fee Schedule list every rate.`;
  let notified = 0;
  let emailed = 0;
  for (const s of sellers) {
    const already = await prisma.notification.count({ where: { userId: s.userId, type: 'REFERRAL_FEES_CHANGED', linkHref: `/pages/referral-fee-schedule?v=${version}` } });
    if (already === 0) {
      await prisma.notification.create({
        data: { userId: s.userId, type: 'REFERRAL_FEES_CHANGED', title, body, linkHref: `/pages/referral-fee-schedule?v=${version}` },
      });
      notified += 1;
    }
    const to = s.user.email || s.storeEmail;
    if (!to) continue;
    const queued = await enqueueEmail({
      to,
      userId: s.userId,
      kind: 'REFERRAL_FEES_CHANGED',
      dedupeKey: `referral-fees:v${version}:${s.id}`,
      subject: 'Clowe referral fees: by category and price slab — Clowe',
      title,
      body: [`${s.shopName},`, body, 'You will be asked to accept the updated Seller Terms the next time you open your dashboard.'].join('\n\n'),
      ctaHref: '/pages/referral-fee-schedule',
      ctaLabel: 'See the fee schedule',
    });
    if (queued) emailed += 1;
  }
  return { notified, emailed };
}
