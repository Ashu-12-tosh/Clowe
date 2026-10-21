/**
 * The owner's referral fee schedule, from the spreadsheet, and which schedule
 * category each Clowe category is charged under.
 *
 * Dry run by default — nothing is written. It reads the sheet "Clowe Fee
 * Schedule" (Group, Category, Item Price Slab, Benchmark, CLOWE Rate), lists
 * every gap and the "… - Other products" row that fills it (or that nothing
 * does), shows the mapping for every category (with its live products and
 * today's flat rate), the categories left unmapped, and the ₹1,000 and ₹1,500
 * shirt examples under the new rates.
 *
 * --apply saves the rates as the next schedule version, in force from now (or
 * --effective-from=ISO): orders placed from then are charged under it, orders
 * placed before keep their fees. It sets each mapped category's schedule
 * category, writes what each was before to --record=<file>, and tells every
 * seller (bell + email, once per version) unless --no-notify.
 *
 *   dc exec api npx tsx prisma/importReferralFees.ts --file=/tmp/fees.xlsx [--apply] [--record=/tmp/previous.json]   # production
 *   npx tsx prisma/importReferralFees.ts --file="D:/Clowe/Clowe-banners/Clowe_Referral_Fee_Schedule (6).xlsx"        # dev
 */
// env first: it layers .env.local over .env, and nothing may load .env before it.
import '../src/env';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { bpsToPercent, computeListingEconomics, gstRateForInclusive, slabDescription, slabFor, type ReferralFeeSlab } from '@clowe/shared';
import { prisma } from '../src/db';
import { categoryRulesMap } from '../src/services/categoryRules';
import { getCommercial } from '../src/services/commercial';
import { economicsRates, gstSettings } from '../src/services/economicsRates';
import { getSettings } from '../src/services/settingsService';
import { CATEGORY_MAPPING, GAP_DONORS, GAP_RATES } from '../src/services/referralFees/categoryMapping';
import { applyCategoryMapping, createScheduleVersion, notifySellersOfSchedule } from '../src/services/referralFees/apply';
import { FEE_SHEET_NAME, parseFeeSheet, scheduleRates } from '../src/services/referralFees/sheet';
import { readSheet } from '../src/services/referralFees/xlsx';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const pct = (bps: number) => `${bpsToPercent(bps)}%`;

async function main() {
  const file = arg('file');
  if (!file) throw new Error('Pass --file=<path to the .xlsx>');
  const apply = flag('apply');
  const effectiveFrom = arg('effective-from') ? new Date(arg('effective-from')!) : new Date();
  if (Number.isNaN(effectiveFrom.getTime())) throw new Error('--effective-from is not a date');

  // ---------------- the sheet ----------------
  const { categories: sheet, problems } = parseFeeSheet(readSheet(file, FEE_SHEET_NAME));
  const { rates, gaps } = scheduleRates(sheet, GAP_DONORS, GAP_RATES);
  const sheetNames = new Set(sheet.map((c) => c.sheetCategory));
  const rows = sheet.reduce((n, c) => n + c.slabs.length, 0);
  console.log(`\n=== ${basename(file)} — sheet "${FEE_SHEET_NAME}" ===`);
  console.log(`${rows} slab rows, ${sheet.length} categories:`);
  for (const g of [...new Set(sheet.map((c) => c.group))]) console.log(`  ${g}: ${sheet.filter((c) => c.group === g).length} categories`);
  console.log(`${rates.length} rates to store (the sheet's ${rows} + ${rates.length - rows} filled gaps)`);
  const provisional = rates.filter((r) => r.provisional);
  if (provisional.length) console.log(`Provisional (to confirm): ${provisional.map((r) => `${r.sheetCategory} ${r.slabLabel} ${r.rateBps / 100}%`).join('; ')}`);
  if (problems.length) {
    console.log(`\n!!! ${problems.length} rows not understood — nothing is applied until they are fixed:`);
    for (const p of problems) console.log(`  ${p}`);
  }

  console.log(`\n=== Gaps (price ranges a category's own rows leave out): ${gaps.length} ===`);
  for (const g of gaps) {
    console.log(
      `  [${g.group}] ${g.sheetCategory}, ${g.range}: ${
        g.borrowedFrom
          ? `${g.borrowedFrom}${g.chosen ? ' (your choice)' : ''}`
          : g.ownerRate
            ? `${g.ownerRate.ratePercent}% set by you (${g.ownerRate.note})${g.ownerRate.provisional ? ', provisional' : ''}`
            : 'NO "Other products" row fits — stays on the flat rate until you choose one'
      }`,
    );
  }

  // ---------------- the mapping ----------------
  const categories = await prisma.category.findMany({
    select: { id: true, slug: true, name: true, parentId: true, isActive: true, referralPercent: true, referralFeeCategory: true },
    orderBy: { slug: 'asc' },
  });
  const live = await prisma.product.groupBy({ by: ['categoryId'], where: { status: 'APPROVED', isVisible: true }, _count: { _all: true } });
  const liveBy = new Map(live.map((l) => [l.categoryId, l._count._all]));
  const byId = new Map(categories.map((c) => [c.id, c]));
  const path = (c: (typeof categories)[number]): string => (c.parentId && byId.get(c.parentId) ? `${path(byId.get(c.parentId)!)} › ${c.name}` : c.name);
  const slabsOf = (name: string): ReferralFeeSlab[] => rates.filter((r) => r.sheetCategory === name).map((r) => ({ abovePaise: r.abovePaise, upToPaise: r.upToPaise, rateBps: r.rateBps, label: r.slabLabel, borrowedFrom: r.borrowedFrom }));

  console.log(`\n=== Mapping: ${categories.length} categories ===`);
  console.log('slug | category | live products | flat rate today | → schedule category | rates (unit price incl. GST) | note');
  const mapping: { categoryId: string; sheetCategory: string }[] = [];
  const unmapped: (typeof categories)[number][] = [];
  const notInSheet: string[] = [];
  for (const c of categories) {
    const entry = CATEGORY_MAPPING[c.slug];
    const own = entry && sheetNames.has(entry.sheetCategory) ? entry.sheetCategory : null;
    if (entry && !own) notInSheet.push(`${c.slug} → "${entry.sheetCategory}" is not a category in the sheet`);
    if (own) mapping.push({ categoryId: c.id, sheetCategory: own });
    else unmapped.push(c);
    const shown = own
      ? slabsOf(own)
          .map((s) => `${slabDescription(s)} ${pct(s.rateBps)}${s.borrowedFrom ? '*' : ''}`)
          .join('; ')
      : '';
    console.log(
      `${c.slug} | ${path(c)}${c.isActive ? '' : ' (inactive)'} | ${liveBy.get(c.id) ?? 0} | ${c.referralPercent}% | ${own ?? '— (unmapped)'} | ${shown} | ${entry?.note ?? ''}`,
    );
  }
  console.log('(* = a gap filled from the "… - Other products" row)');
  for (const n of notInSheet) console.log(`!!! ${n}`);
  const mappedIds = new Set(mapping.map((m) => m.categoryId));
  const inherits = (c: (typeof categories)[number]): boolean => {
    let at = c.parentId ? byId.get(c.parentId) : undefined;
    while (at) {
      if (mappedIds.has(at.id)) return true;
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
    return false;
  };
  console.log(`\n=== Unmapped: ${unmapped.length} ===`);
  for (const c of unmapped) {
    console.log(`  ${c.slug} (${path(c)}${c.isActive ? '' : ', inactive'}; ${liveBy.get(c.id) ?? 0} live): ${inherits(c) ? "inherits its parent's schedule category" : `keeps its flat ${c.referralPercent}%`}`);
  }
  const unknownSlugs = Object.keys(CATEGORY_MAPPING).filter((slug) => !categories.some((c) => c.slug === slug));
  if (unknownSlugs.length) console.log(`\nMapping entries for categories this database does not have (ignored): ${unknownSlugs.join(', ')}`);

  // ---------------- the shirt examples ----------------
  const shirts = categories.find((c) => c.slug === 'men-shirts');
  const shirtSheet = shirts && mapping.find((m) => m.categoryId === shirts.id)?.sheetCategory;
  if (shirts && shirtSheet) {
    const settings = await getSettings();
    const rules = (await categoryRulesMap([shirts.id])).get(shirts.id);
    const c = await getCommercial();
    console.log(`\n=== Examples: ${path(shirts)} (${shirtSheet}), one unit, Free plan ===`);
    for (const price of [100_000, 150_000]) {
      const gstRatePercent = gstRateForInclusive(price, rules, gstSettings(settings)).ratePercent;
      const slabs = slabsOf(shirtSheet);
      const slab = slabFor(slabs, price)!;
      const flat = computeListingEconomics({ buyerPricePaise: price, gstRatePercent, rates: { ...economicsRates(settings), v2: { ...c.fees, referralPercent: shirts.referralPercent, handlingWaived: false } } });
      const e = computeListingEconomics({ buyerPricePaise: price, gstRatePercent, rates: { ...economicsRates(settings), v2: { ...c.fees, referralSlabs: slabs, handlingWaived: false } } });
      console.log(`\n${rupees(price)} (GST ${gstRatePercent}% included) — slab ${slabDescription(slab)}: ${pct(slab.rateBps)}${slab.borrowedFrom ? ` (${slab.borrowedFrom})` : ''}`);
      for (const l of e.lines) console.log(`  ${l.label.padEnd(48)} ${(l.amountPaise < 0 ? '−' : ' ') + rupees(Math.abs(l.amountPaise))}`);
      console.log(`  ${'Seller receives'.padEnd(48)}  ${rupees(e.sellerReceivesPaise)}   (today, at the flat ${shirts.referralPercent}%: ${rupees(flat.sellerReceivesPaise)})`);
      console.log(`  ${'GST on the sale (the seller remits)'.padEnd(48)}  ${rupees(e.gstPaise)} → keeps ${rupees(e.sellerKeepsAfterGstPaise)}`);
    }
  }

  const versions = await prisma.referralFeeSchedule.findMany({ orderBy: { version: 'asc' }, select: { version: true, source: true, effectiveFrom: true } });
  console.log(`\nSchedule versions stored now: ${versions.length ? versions.map((v) => `v${v.version} (${v.source}, from ${v.effectiveFrom.toISOString()})`).join('; ') : 'none'}`);

  if (!apply) {
    console.log(`\nDry run — nothing written. --apply saves these ${rates.length} rates as version ${(versions.at(-1)?.version ?? 0) + 1}, in force from ${effectiveFrom.toISOString()}, and maps ${mapping.length} categories.`);
    return;
  }
  if (problems.length || notInSheet.length) throw new Error('Not applied: fix the rows and mapping entries listed above first');

  // ---------------- apply ----------------
  const created = await createScheduleVersion({ rates, source: basename(file), effectiveFrom, note: 'Imported from the owner’s fee schedule' });
  const changes = await applyCategoryMapping(mapping);
  const record = {
    appliedAt: new Date().toISOString(),
    scheduleVersion: created.version,
    scheduleId: created.id,
    effectiveFrom: effectiveFrom.toISOString(),
    categories: changes.map((ch) => ({ id: ch.categoryId, slug: byId.get(ch.categoryId)?.slug, referralFeeCategoryBefore: ch.before, referralFeeCategoryAfter: ch.after })),
  };
  const recordPath = arg('record');
  if (recordPath) writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`\nApplied: version ${created.version} (${rates.length} rates), in force from ${effectiveFrom.toISOString()}; ${changes.length} categories mapped.${recordPath ? ` Previous values: ${recordPath}` : ''}`);
  if (!flag('no-notify')) {
    const told = await notifySellersOfSchedule(created.version);
    console.log(`Sellers told: ${told.notified} in the app, ${told.emailed} emails queued.`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
