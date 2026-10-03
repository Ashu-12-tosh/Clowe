/**
 * The owner's decision: one GST rate, 18%, for every product in every
 * category. This switches the platform to it (setting gstUniformPercent) and
 * recomputes every buyer price from the seller's price before GST. The
 * category rules and the apparel/footwear value slab stay in the database and
 * in code, unused; clearing the flat rate in admin settings brings them back.
 *
 * Dry run by default — nothing is written. It reports how many variants'
 * buyer prices change, the biggest increases, and totals per category. Pass
 * --apply to do it: past order lines keep the rate they were sold at (their
 * rate is recorded first), seller prices stay as they are.
 *
 *   dc exec api npx tsx prisma/applyFlatGst.ts [--apply] [--rate=18]          # production
 *   npm run db:apply-flat-gst --workspace=@clowe/api [-- --apply]             # dev checkout only
 *
 * npm run fails on the server (tsx: not found): the image prunes dev dependencies.
 */
// env first: it layers .env.local over .env, and nothing may load .env before it.
import '../src/env';
import { prisma } from '../src/db';
import { gstSettings } from '../src/services/economicsRates';
import { getSettings, setSetting } from '../src/services/settingsService';
import { changeGstRules, ensureSellerPrices, repriceProducts, type PriceChange } from '../src/services/sellerPricing';

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedRupees = (paise: number) => `${paise >= 0 ? '+' : '−'}${rupees(Math.abs(paise))}`;
const pct = (from: number, to: number) => (from > 0 ? `${(((to - from) / from) * 100).toFixed(1)}%` : '—');

async function report(changes: PriceChange[], rate: number) {
  const [variantTotal, categories, variantsPerCategory] = await Promise.all([
    prisma.productVariant.count(),
    prisma.category.findMany({ select: { id: true, name: true, parentId: true } }),
    prisma.$queryRaw<{ categoryId: string; n: number }[]>`
      SELECT p."categoryId", count(*)::int AS n
      FROM product_variants v JOIN products p ON p.id = v."productId"
      GROUP BY p."categoryId"`,
  ]);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const pathOf = (id: string): string => {
    const c = byId.get(id);
    if (!c) return id;
    return c.parentId ? `${pathOf(c.parentId)} › ${c.name}` : c.name;
  };

  const up = changes.filter((c) => c.buyerAfter > c.buyerBefore);
  const down = changes.filter((c) => c.buyerAfter < c.buyerBefore);
  console.log(`\n[flat-gst] ${rate}% on every product.`);
  console.log(
    `[flat-gst] Variants: ${variantTotal}. Buyer price changes on ${changes.length}` +
      ` (${up.length} up, ${down.length} down); ${variantTotal - changes.length} unchanged.`,
  );

  console.log('\nBiggest increases (buyer price, one unit):');
  for (const c of [...up].sort((a, b) => b.buyerAfter - b.buyerBefore - (a.buyerAfter - a.buyerBefore)).slice(0, 15)) {
    console.log(
      `  ${signedRupees(c.buyerAfter - c.buyerBefore)} (${pct(c.buyerBefore, c.buyerAfter)})  ${rupees(c.buyerBefore)} -> ${rupees(c.buyerAfter)}` +
        `  ${c.title}${c.label ? ` · ${c.label}` : ''}  [${pathOf(c.categoryId)}]`,
    );
  }
  if (down.length) {
    console.log('\nBiggest decreases:');
    for (const c of [...down].sort((a, b) => a.buyerAfter - a.buyerBefore - (b.buyerAfter - b.buyerBefore)).slice(0, 5)) {
      console.log(`  ${signedRupees(c.buyerAfter - c.buyerBefore)}  ${rupees(c.buyerBefore)} -> ${rupees(c.buyerAfter)}  ${c.title}  [${pathOf(c.categoryId)}]`);
    }
  }

  // Per category: every variant counted, totals over the ones that change.
  const rows = new Map<string, { variants: number; changed: number; before: number; after: number }>();
  for (const v of variantsPerCategory) rows.set(v.categoryId, { variants: v.n, changed: 0, before: 0, after: 0 });
  for (const c of changes) {
    const row = rows.get(c.categoryId) ?? { variants: 0, changed: 0, before: 0, after: 0 };
    row.changed += 1;
    row.before += c.buyerBefore;
    row.after += c.buyerAfter;
    rows.set(c.categoryId, row);
  }
  console.log('\nPer category (totals over the variants that change, one unit each):');
  const sorted = [...rows.entries()].sort((a, b) => b[1].after - b[1].before - (a[1].after - a[1].before));
  let before = 0;
  let after = 0;
  for (const [id, r] of sorted) {
    before += r.before;
    after += r.after;
    const change = r.changed ? `  ${rupees(r.before)} -> ${rupees(r.after)}  ${signedRupees(r.after - r.before)} (${pct(r.before, r.after)})` : '';
    console.log(`  ${pathOf(id)}: ${r.changed}/${r.variants} variants change${change}`);
  }
  console.log(`  All categories: ${rupees(before)} -> ${rupees(after)}  ${signedRupees(after - before)} (${pct(before, after)})`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const rateArg = process.argv.find((a) => a.startsWith('--rate='));
  const rate = rateArg ? Number(rateArg.slice('--rate='.length)) : 18;
  if (!Number.isInteger(rate) || rate < 0 || rate > 40) throw new Error(`--rate must be a whole percent from 0 to 40, got ${rateArg}`);

  const settings = await getSettings();
  if (settings.gstUniformPercent === rate) {
    console.log(`[flat-gst] ${rate}% on every product is already in force; nothing to do.`);
    return;
  }
  const missingSeller = (await ensureSellerPrices({}, false)).length;
  const missingRate = await prisma.orderItem.count({ where: { gstRatePercent: null } });

  if (!apply) {
    const changes = await repriceProducts({}, { priceGst: { ...gstSettings(settings), uniformPercent: rate }, apply: false });
    await report(changes, rate);
    console.log(
      `\n[flat-gst] Dry run: nothing written. --apply would first record the rate on ${missingRate} order lines` +
        ` without one and the seller price on ${missingSeller} variants without one (under today's rules),` +
        ` then switch to ${rate}% and reprice.`,
    );
    return;
  }

  const changes = await changeGstRules(() => setSetting('gstUniformPercent', rate));
  await report(changes, rate);
  console.log(`\n[flat-gst] Applied: ${rate}% on every product; ${changes.length} buyer prices rewritten.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
