/**
 * Sellers now enter prices BEFORE GST. This gives every variant priced before
 * that its seller price: sellerPricePaise = buyer price / (1 + GST rate), at
 * the rate its category and price have today. The buyer price columns are not
 * written at all, so no shopper-facing price changes, to the paisa.
 *
 * Dry run by default: prints every product's variants, buyer price before and
 * after (always the same), the seller price it would store and the GST in
 * between, and flags any price in the value-slab band (₹2,625–₹2,950 at
 * 5/18% on ₹2,500), whose seller price would be taxed at 5% if the seller
 * re-saved it. Pass --apply to write. Safe to re-run: variants that have a
 * seller price are skipped.
 *
 *   dc exec api npx tsx prisma/backfillSellerPrices.ts [--apply]              # production
 *   npm run db:backfill-seller-prices --workspace=@clowe/api [-- --apply]     # dev checkout only
 *
 * npm run fails on the server (tsx: not found): the image prunes dev dependencies.
 */
// env first: it layers .env.local over .env, and nothing may load .env before it.
import '../src/env';
import { prisma } from '../src/db';
import { ensureSellerPrices } from '../src/services/sellerPricing';

const rupees = (paise: number | null) =>
  paise === null ? '—' : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const apply = process.argv.includes('--apply');
  const changes = await ensureSellerPrices({}, apply);

  let product = '';
  for (const c of changes) {
    if (c.productId !== product) {
      product = c.productId;
      console.log(`\n${c.title} (${c.productId})`);
    }
    const unchanged = c.buyerBefore === c.buyerAfter && c.mrpBuyerBefore === c.mrpBuyerAfter;
    console.log(
      `  ${c.label || '(single)'}: buyer ${rupees(c.buyerBefore)} -> ${rupees(c.buyerAfter)}` +
        ` | seller ${rupees(c.sellerPrice)} + GST ${c.ratePercent}% ${rupees(c.buyerBefore - c.sellerPrice)}` +
        (c.mrpBuyerBefore !== null ? ` | MRP buyer ${rupees(c.mrpBuyerBefore)}, seller ${rupees(c.sellerMrp)}` : '') +
        (unchanged ? '' : '  !! BUYER PRICE WOULD CHANGE') +
        (c.ambiguous ? '  ** value-slab band: 5% if re-saved at this seller price' : ''),
    );
  }

  const products = new Set(changes.map((c) => c.productId)).size;
  const moved = changes.filter((c) => c.buyerBefore !== c.buyerAfter || c.mrpBuyerBefore !== c.mrpBuyerAfter).length;
  const band = changes.filter((c) => c.ambiguous).length;
  console.log(
    `\n[seller-prices] ${apply ? 'Wrote' : 'Would write'} seller prices for ${changes.length} variants on ${products} products.` +
      ` Buyer prices changed: ${moved}. In the value-slab band: ${band}.`,
  );
  if (!apply) console.log('[seller-prices] Dry run. Pass --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
