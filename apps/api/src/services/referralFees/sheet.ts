import {
  decimalRateToBps,
  fillSlabGaps,
  parseSlabLabel,
  slabDescription,
  type ReferralFeeCategory,
  type ReferralFeeSlab,
} from '@clowe/shared';
import type { SheetRow } from './xlsx';

// ---------------------------------------------------------------------------
// The owner's fee schedule, sheet "Clowe Fee Schedule": a header row "Group |
// Category | Item Price Slab (INR) | Benchmark Rate | CLOWE Rate | …", then one
// row per slab. Group headings (a Group with no Category) are skipped. The
// CLOWE Rate is taken exactly as the sheet holds it.
// ---------------------------------------------------------------------------

export const FEE_SHEET_NAME = 'Clowe Fee Schedule';

export interface ParsedSlab extends ReferralFeeSlab {
  benchmarkBps: number | null;
}
export interface ParsedCategory extends ReferralFeeCategory {
  slabs: ParsedSlab[];
}

export interface ScheduleRate {
  group: string;
  sheetCategory: string;
  slabLabel: string;
  abovePaise: number;
  upToPaise: number | null;
  rateBps: number;
  benchmarkBps: number | null;
  borrowedFrom: string | null;
}

export interface ScheduleGap {
  group: string;
  sheetCategory: string;
  /** The price range the sheet leaves out, in words. */
  range: string;
  /** The row it borrows from, or null when none fits (left on the flat rate). */
  borrowedFrom: string | null;
  /** Whether the owner chose it (vs the "same family" rule). */
  chosen: boolean;
}

const HEADER = ['Group', 'Category', 'Item Price Slab (INR)', 'Benchmark Rate', 'CLOWE Rate'];

/** The sheet's rows as categories and slabs; every row it cannot read is a problem, not skipped. */
export function parseFeeSheet(rows: SheetRow[]): { categories: ParsedCategory[]; problems: string[] } {
  const headerAt = rows.findIndex((r) => HEADER.every((h, i) => (r[String.fromCharCode(65 + i)] ?? '').trim() === h));
  if (headerAt < 0) throw new Error(`No header row "${HEADER.join(' | ')}" in the sheet`);
  const problems: string[] = [];
  const byName = new Map<string, ParsedCategory>();
  rows.slice(headerAt + 1).forEach((r, i) => {
    const line = headerAt + 2 + i;
    const group = (r.A ?? '').trim();
    const name = (r.B ?? '').trim();
    if (!name) return; // a group heading or a blank row
    const label = (r.C ?? '').trim();
    const bounds = parseSlabLabel(label);
    if (!bounds) return void problems.push(`Row ${line}: "${name}" — slab "${label}" not understood`);
    let rateBps: number;
    try {
      rateBps = decimalRateToBps(r.E ?? '');
    } catch {
      return void problems.push(`Row ${line}: "${name}" ${label} — CLOWE Rate "${r.E ?? ''}" is not a rate`);
    }
    let benchmarkBps: number | null = null;
    try {
      benchmarkBps = r.D ? decimalRateToBps(r.D) : null;
    } catch {
      benchmarkBps = null;
    }
    const category = byName.get(name) ?? { group, sheetCategory: name, slabs: [] };
    if (category.group !== group) problems.push(`Row ${line}: "${name}" is in both ${category.group} and ${group}`);
    category.slabs.push({ ...bounds, rateBps, label, benchmarkBps });
    byName.set(name, category);
  });
  for (const c of byName.values()) {
    const sorted = [...c.slabs].sort((a, b) => a.abovePaise - b.abovePaise);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      if (prev.upToPaise === null || sorted[i]!.abovePaise < prev.upToPaise) problems.push(`"${c.sheetCategory}": slabs "${prev.label}" and "${sorted[i]!.label}" overlap`);
    }
  }
  return { categories: [...byName.values()], problems };
}

/**
 * Every category's slabs as stored: the sheet's own, and each gap filled from
 * its family's "… - Other products" row (or the row the owner chose in
 * `donors`). Gaps nothing fills are listed and stay unstored, so sales there
 * keep the category's flat rate.
 */
export function scheduleRates(categories: ParsedCategory[], donors: Record<string, string> = {}): { rates: ScheduleRate[]; gaps: ScheduleGap[] } {
  const byName = new Map(categories.map((c) => [c.sheetCategory, c]));
  const rates: ScheduleRate[] = [];
  const gaps: ScheduleGap[] = [];
  for (const c of categories) {
    const chosen = donors[c.sheetCategory] ?? null;
    const filled = fillSlabGaps(c, byName, chosen);
    for (const s of filled.slabs) {
      const own = s as Partial<ParsedSlab>;
      rates.push({
        group: c.group,
        sheetCategory: c.sheetCategory,
        slabLabel: s.label,
        abovePaise: s.abovePaise,
        upToPaise: s.upToPaise,
        rateBps: s.rateBps,
        benchmarkBps: s.borrowedFrom ? null : (own.benchmarkBps ?? null),
        borrowedFrom: s.borrowedFrom ?? null,
      });
      if (s.borrowedFrom) gaps.push({ group: c.group, sheetCategory: c.sheetCategory, range: slabDescription(s), borrowedFrom: s.borrowedFrom, chosen: !!chosen });
    }
    for (const [from, to] of filled.unfilled) {
      gaps.push({ group: c.group, sheetCategory: c.sheetCategory, range: slabDescription({ abovePaise: from, upToPaise: to }), borrowedFrom: null, chosen: false });
    }
  }
  return { rates, gaps };
}
