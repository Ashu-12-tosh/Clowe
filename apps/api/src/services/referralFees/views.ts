import {
  gstRateForInclusive,
  type CategoryReferralSlabs,
  type PublicReferralSchedule,
  type ReferralFeeSlab,
} from '@clowe/shared';
import { prisma } from '../../db';
import { categoryRulesMap } from '../categoryRules';
import { gstSettings } from '../economicsRates';
import { getSettings } from '../settingsService';
import { activeReferralSchedule, sheetCategoryByCategory } from './index';

// What sellers and the public see of the schedule in force.

/** The worked examples' products: a shirt at ₹1,000 and at ₹1,500, in Men › Shirts. */
const EXAMPLES = [
  { slug: 'men-shirts', title: 'A shirt at ₹1,000', pricePaise: 100_000 },
  { slug: 'men-shirts', title: 'A shirt at ₹1,500', pricePaise: 150_000 },
];

/** The schedule in force for the fee pages, with the examples priced under it; null before one takes effect. */
export async function publicReferralSchedule(): Promise<PublicReferralSchedule | null> {
  const schedule = await activeReferralSchedule();
  if (!schedule) return null;
  const categories = await prisma.category.findMany({ where: { slug: { in: EXAMPLES.map((x) => x.slug) } }, select: { id: true, slug: true } });
  const mapping = await sheetCategoryByCategory();
  const rules = await categoryRulesMap(categories.map((c) => c.id));
  const gst = gstSettings(await getSettings());
  const examples: PublicReferralSchedule['examples'] = [];
  for (const x of EXAMPLES) {
    const category = categories.find((c) => c.slug === x.slug);
    const sheetCategory = category ? mapping.get(category.id) : null;
    const slabs = sheetCategory ? schedule.slabsBySheetCategory.get(sheetCategory) : undefined;
    if (!category || !sheetCategory || !slabs?.length) continue;
    examples.push({
      title: x.title,
      pricePaise: x.pricePaise,
      gstRatePercent: gstRateForInclusive(x.pricePaise, rules.get(category.id), gst).ratePercent,
      sheetCategory,
      slabs,
    });
  }
  return { version: schedule.version, effectiveFrom: schedule.effectiveFrom.toISOString(), examples };
}

/** Each category's slabs under the schedule in force, for the pricing calculator. */
export async function referralSlabsByCategory(): Promise<Record<string, CategoryReferralSlabs>> {
  const [schedule, mapping] = await Promise.all([activeReferralSchedule(), sheetCategoryByCategory()]);
  const out: Record<string, CategoryReferralSlabs> = {};
  if (!schedule) return out;
  for (const [categoryId, sheetCategory] of mapping) {
    const slabs = sheetCategory ? schedule.slabsBySheetCategory.get(sheetCategory) : undefined;
    if (sheetCategory && slabs?.length) out[categoryId] = { scheduleVersion: schedule.version, sheetCategory, slabs };
  }
  return out;
}

export interface ReferralScheduleTable {
  version: number;
  effectiveFrom: string;
  source: string;
  groups: {
    group: string;
    categories: { sheetCategory: string; slabs: (ReferralFeeSlab & { benchmarkBps: number | null; provisional: boolean; note: string | null })[] }[];
  }[];
}

/** A whole schedule version, grouped as the sheet is, for the public page and the admin. */
export async function scheduleTable(version?: number): Promise<ReferralScheduleTable | null> {
  const row = version
    ? await prisma.referralFeeSchedule.findUnique({ where: { version }, include: { rates: true } })
    : await prisma.referralFeeSchedule.findFirst({ where: { effectiveFrom: { lte: new Date() } }, orderBy: { version: 'desc' }, include: { rates: true } });
  if (!row) return null;
  type Row = ReferralFeeSlab & { benchmarkBps: number | null; provisional: boolean; note: string | null };
  const groups = new Map<string, Map<string, Row[]>>();
  // Rows keep the sheet's order.
  for (const r of [...row.rates].sort((a, b) => a.position - b.position)) {
    const g = groups.get(r.group) ?? new Map();
    const list = g.get(r.sheetCategory) ?? [];
    list.push({
      abovePaise: r.abovePaise,
      upToPaise: r.upToPaise,
      rateBps: r.rateBps,
      label: r.slabLabel,
      borrowedFrom: r.borrowedFrom,
      benchmarkBps: r.benchmarkBps,
      provisional: r.provisional,
      note: r.note,
    });
    g.set(r.sheetCategory, list);
    groups.set(r.group, g);
  }
  return {
    version: row.version,
    effectiveFrom: row.effectiveFrom.toISOString(),
    source: row.source,
    groups: [...groups].map(([group, cats]) => ({
      group,
      categories: [...cats].map(([sheetCategory, slabs]) => ({ sheetCategory, slabs: slabs.sort((a, b) => a.abovePaise - b.abovePaise) })),
    })),
  };
}
