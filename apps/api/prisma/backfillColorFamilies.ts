// Give every coloured variant the colour family the filter rail groups on.
//
// Why: sellers name colours freely — the demo catalog alone has 49 distinct
// names, Powder Blue, Sky Blue, Ocean Blue, Dark Blue and Navy among them —
// and a shopper filtering for "blue" wants all of them. Since BF2 the API
// writes optionValues.color_family beside the colour on every save; the
// variants already in the database need the same once.
//
// What it does: for each variant whose option map names a colour, computes
// the family with the shared lookup and stores it, exactly as a save would.
// Variants already carrying the right family are untouched, so a second run
// updates 0. Colours the lookup cannot place are printed, not guessed: add
// them to packages/shared/src/colorFamily.ts and run again.
//
// Run with: npm run db:backfill-color-families --workspace=@clowe/api
// On the server: dc exec api npx tsx prisma/backfillColorFamilies.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { backfillColorFamilies } from './seed/colorFamilies';

const prisma = new PrismaClient();

async function main() {
  const r = await backfillColorFamilies(prisma);
  console.log(`[colour] variants updated: ${r.updated} of ${r.checked} with a colour`);
  if (r.unmatched.size === 0) {
    console.log('[colour] every colour name has a family');
  } else {
    for (const [name, count] of [...r.unmatched.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`[colour] no family for "${name}" (${count} variants)`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
