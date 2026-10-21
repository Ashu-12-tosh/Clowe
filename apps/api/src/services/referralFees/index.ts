import type { ReferralFeeSlab, ReferralFeeSource } from '@clowe/shared';
import { referralPercentFor } from '@clowe/shared';
import { prisma } from '../../db';

// ---------------------------------------------------------------------------
// The referral fee schedule in force: the newest version whose effectiveFrom
// has passed, and each Clowe category's schedule category (its own, else its
// nearest parent's). Read often (checkout, the listing form), changed rarely:
// cached briefly and dropped on every change made here.
// ---------------------------------------------------------------------------

const TTL_MS = 60_000;

interface ActiveSchedule {
  version: number;
  effectiveFrom: Date;
  slabsBySheetCategory: Map<string, ReferralFeeSlab[]>;
}

let scheduleCache: { at: number; value: ActiveSchedule | null } | null = null;
let mappingCache: { at: number; value: Map<string, string | null> } | null = null;

export function invalidateReferralFees(): void {
  scheduleCache = null;
  mappingCache = null;
}

/** The schedule that applies to an order placed now (or at `at`), or null when none has taken effect. */
export async function activeReferralSchedule(at: Date = new Date()): Promise<ActiveSchedule | null> {
  const cacheable = Math.abs(at.getTime() - Date.now()) < 1_000;
  if (cacheable && scheduleCache && Date.now() - scheduleCache.at < TTL_MS) {
    // A version that takes effect later must not wait out the cache.
    const cached = scheduleCache.value;
    const next = await prisma.referralFeeSchedule.findFirst({
      where: { effectiveFrom: { lte: at }, version: { gt: cached?.version ?? 0 } },
      select: { id: true },
    });
    if (!next) return cached;
  }
  const row = await prisma.referralFeeSchedule.findFirst({
    where: { effectiveFrom: { lte: at } },
    orderBy: { version: 'desc' },
    include: { rates: true },
  });
  const value: ActiveSchedule | null = row
    ? {
        version: row.version,
        effectiveFrom: row.effectiveFrom,
        slabsBySheetCategory: row.rates.reduce((map, r) => {
          const list = map.get(r.sheetCategory) ?? [];
          list.push({ abovePaise: r.abovePaise, upToPaise: r.upToPaise, rateBps: r.rateBps, label: r.slabLabel, borrowedFrom: r.borrowedFrom });
          map.set(r.sheetCategory, list);
          return map;
        }, new Map<string, ReferralFeeSlab[]>()),
      }
    : null;
  for (const list of value?.slabsBySheetCategory.values() ?? []) list.sort((a, b) => a.abovePaise - b.abovePaise);
  if (cacheable) scheduleCache = { at: Date.now(), value };
  return value;
}

/** Every category's schedule category: its own, else the nearest parent's, else null. */
export async function sheetCategoryByCategory(): Promise<Map<string, string | null>> {
  if (mappingCache && Date.now() - mappingCache.at < TTL_MS) return mappingCache.value;
  const rows = await prisma.category.findMany({ select: { id: true, parentId: true, referralFeeCategory: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string | null>();
  for (const r of rows) {
    let at: (typeof rows)[number] | undefined = r;
    const seen = new Set<string>();
    while (at && !at.referralFeeCategory && at.parentId && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.parentId);
    }
    out.set(r.id, at?.referralFeeCategory ?? null);
  }
  mappingCache = { at: Date.now(), value: out };
  return out;
}

/** A category's slabs under the schedule in force, with where they came from; null = the flat rate applies. */
export async function referralSlabsFor(categoryId: string): Promise<{ version: number; sheetCategory: string; slabs: ReferralFeeSlab[] } | null> {
  const [schedule, mapping] = await Promise.all([activeReferralSchedule(), sheetCategoryByCategory()]);
  const sheetCategory = mapping.get(categoryId) ?? null;
  const slabs = schedule && sheetCategory ? schedule.slabsBySheetCategory.get(sheetCategory) : undefined;
  return schedule && sheetCategory && slabs?.length ? { version: schedule.version, sheetCategory, slabs } : null;
}

/**
 * The referral percent an order line is sold under: its category's slab for
 * the unit price (GST included), or the category's flat percent when it has
 * no schedule category or no slab holds the price.
 */
export async function referralForLine(
  categoryId: string,
  unitPricePaise: number,
  flatPercent: number,
): Promise<{ percent: number; source: ReferralFeeSource | null }> {
  const found = await referralSlabsFor(categoryId);
  const { percent, slab } = referralPercentFor(found?.slabs, unitPricePaise, flatPercent);
  return {
    percent,
    source:
      found && slab
        ? { scheduleVersion: found.version, sheetCategory: found.sheetCategory, slabLabel: slab.label, rateBps: slab.rateBps, borrowedFrom: slab.borrowedFrom ?? null }
        : null,
  };
}
