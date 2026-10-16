import { mergeCommercial, placementPriceProblems, type CommercialSettings, type FeeChangeView } from '@clowe/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { auditSafe } from './auditService';
import { getCommercial, updateCommercial } from './commercial';
import { sendToUserSafe } from './messaging';

// ---------------------------------------------------------------------------
// Fee changes announced ahead (owner's Batch 2): an admin schedules a change
// to the commercial rules for a date at least noticeDays away; every approved
// seller is told by email, SMS and the dashboard; it applies by itself on the
// date (merged over whatever is in force then) and sellers are told again.
// ---------------------------------------------------------------------------

export const NOTICE_DAYS = 30;
const DAY = 86_400_000;

/** India-time calendar date of an instant. */
const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => (Array.isArray(v) || isObj(v) ? JSON.stringify(v) : String(v));

/** "fees.gtPercent: 1.5 → 2" — one line per value that would change. */
export function describePatch(current: CommercialSettings, patch: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const walk = (cur: unknown, p: unknown, path: string) => {
    if (isObj(p) && isObj(cur)) {
      for (const [k, v] of Object.entries(p)) walk(cur[k], v, path ? `${path}.${k}` : k);
      return;
    }
    if (JSON.stringify(cur) !== JSON.stringify(p)) lines.push(`${path}: ${show(cur)} → ${show(p)}`);
  };
  walk(current, patch, '');
  return lines;
}

async function tellSellers(title: string, body: string) {
  const sellers = await prisma.sellerProfile.findMany({
    where: { status: 'APPROVED' },
    select: { userId: true, user: { select: { phone: true, email: true } } },
  });
  if (sellers.length === 0) return 0;
  await prisma.notification.createMany({
    data: sellers.map((s) => ({ userId: s.userId, type: 'FEE_CHANGE', title, body, linkHref: '/seller/billing' })),
  });
  for (const s of sellers) {
    sendToUserSafe(s.userId, { channel: 'sms', to: `+91${s.user.phone}`, body: `Clowe: ${title}. Details in your seller dashboard.` }, { critical: true });
    if (s.user.email) sendToUserSafe(s.userId, { channel: 'email', to: s.user.email, subject: `Clowe — ${title}`, body }, { critical: true });
  }
  return sellers.length;
}

const toView = (r: { id: string; summary: string; effectiveAt: Date; status: string; createdAt: Date; appliedAt: Date | null; cancelledAt: Date | null }): FeeChangeView => ({
  id: r.id,
  summary: r.summary,
  effectiveAt: r.effectiveAt.toISOString(),
  status: r.status as FeeChangeView['status'],
  createdAt: r.createdAt.toISOString(),
  appliedAt: r.appliedAt?.toISOString() ?? null,
  cancelledAt: r.cancelledAt?.toISOString() ?? null,
});

export async function scheduleFeeChange(adminId: string, patch: Record<string, unknown>, effectiveAt: Date, now: Date = new Date()) {
  const earliest = new Date(new Date(`${istDate(new Date(now.getTime() + NOTICE_DAYS * DAY))}T00:00:00+05:30`).getTime());
  if (effectiveAt < earliest) {
    throw ApiError.badRequest(`A fee change needs ${NOTICE_DAYS} days' notice — the earliest date is ${istDate(earliest)}`, 'NOTICE_TOO_SHORT');
  }
  const current = await getCommercial();
  let next: CommercialSettings;
  try {
    next = mergeCommercial(current, patch);
  } catch (err) {
    throw ApiError.badRequest(`Not scheduled: ${err instanceof Error ? err.message.slice(0, 300) : 'invalid rules'}`, 'COMMERCIAL_INVALID');
  }
  const problems = placementPriceProblems(next);
  if (problems.length) throw ApiError.badRequest(problems.join('; '), 'PRICE_OUT_OF_RANGE');
  const lines = describePatch(current, patch);
  if (lines.length === 0) throw ApiError.badRequest('Nothing would change', 'NO_CHANGE');
  const summary = lines.join('\n');
  const row = await prisma.scheduledFeeChange.create({ data: { patch: patch as Prisma.InputJsonValue, summary, effectiveAt, createdById: adminId } });
  const told = await tellSellers(
    `Fee change from ${istDate(effectiveAt)}`,
    `Clowe's charges change on ${istDate(effectiveAt)} (amounts before GST):\n${summary}\nOrders placed before then keep the old fees.`,
  );
  auditSafe({ actorId: adminId, actorRole: 'ADMIN', module: 'COMMERCIAL', action: 'Fee change scheduled', entityType: 'ScheduledFeeChange', entityId: row.id, summary: `From ${istDate(effectiveAt)}: ${lines.join('; ')} — ${told} sellers told`, metadata: { patch } });
  return { ...toView(row), sellersTold: told };
}

export async function cancelFeeChange(adminId: string, id: string) {
  const row = await prisma.scheduledFeeChange.findUnique({ where: { id } });
  if (!row) throw ApiError.notFound('Fee change not found');
  if (row.status !== 'SCHEDULED') throw ApiError.badRequest('Only a scheduled change can be cancelled', 'NOT_SCHEDULED');
  const done = await prisma.scheduledFeeChange.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  await tellSellers(`Fee change cancelled`, `The fee change announced for ${istDate(row.effectiveAt)} will not happen. Your fees stay as they are.`);
  auditSafe({ actorId: adminId, actorRole: 'ADMIN', module: 'COMMERCIAL', action: 'Fee change cancelled', entityType: 'ScheduledFeeChange', entityId: id, summary: `Cancelled the change for ${istDate(row.effectiveAt)}` });
  return toView(done);
}

export async function listFeeChanges(onlyUpcoming = false): Promise<FeeChangeView[]> {
  const rows = await prisma.scheduledFeeChange.findMany({
    where: onlyUpcoming ? { status: 'SCHEDULED' } : {},
    orderBy: { effectiveAt: onlyUpcoming ? 'asc' : 'desc' },
    take: 50,
  });
  return rows.map(toView);
}

/** Changes whose date has come: applied (merged over the rules then in force), sellers told. */
export async function applyDueFeeChanges(now: Date = new Date()): Promise<number> {
  const due = await prisma.scheduledFeeChange.findMany({ where: { status: 'SCHEDULED', effectiveAt: { lte: now } }, orderBy: { effectiveAt: 'asc' } });
  for (const row of due) {
    const claimed = await prisma.scheduledFeeChange.updateMany({ where: { id: row.id, status: 'SCHEDULED' }, data: { status: 'APPLIED', appliedAt: now } });
    if (claimed.count === 0) continue;
    try {
      await updateCommercial(row.patch as Record<string, unknown>);
    } catch (err) {
      // Back to scheduled, so the admin sees it did not apply and why.
      await prisma.scheduledFeeChange.update({ where: { id: row.id }, data: { status: 'SCHEDULED', appliedAt: null } });
      console.error(`[clowe-api] fee change ${row.id} could not apply:`, err);
      continue;
    }
    await tellSellers(`New fees in effect from today`, `As announced, from ${istDate(row.effectiveAt)}:\n${row.summary}`);
    auditSafe({ actorId: row.createdById, actorRole: 'SYSTEM', module: 'COMMERCIAL', action: 'Fee change applied', entityType: 'ScheduledFeeChange', entityId: row.id, summary: row.summary.replace(/\n/g, '; ') });
  }
  return due.length;
}

export function startFeeChangeJob(): void {
  const run = () => void applyDueFeeChanges().catch((err) => console.error('[clowe-api] fee change job failed:', err));
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}
