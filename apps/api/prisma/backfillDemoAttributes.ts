// Fill the spec sheet of every demo product that was seeded without one.
//
// Why: the seeds wrote no attributes until BF5, so 243 of 245 live products
// on a catalog seeded before then show no Specifications card and give the
// spec-sheet facets nothing to count. The seeds now write rows on create;
// this gives an already-seeded catalog the same rows without a re-seed.
//
// What it does: for each product the seeds wrote (its description carries
// the demo marker) that has no attribute rows, draws one value per field its
// category rule declares from the same slug-seeded pools the seeds use, so
// the rows are identical to what a fresh seed would write. A seller's own
// listing is never touched, nor is any product that already has rows.
// Safe to re-run: the second run fills 0.
//
// Run with: npm run db:backfill-demo-attributes --workspace=@clowe/api (a dev checkout)
// On production: dc exec api npx tsx prisma/backfillDemoAttributes.ts (npm run fails there: tsx is pruned)
// On the server: dc exec api npx tsx prisma/backfillDemoAttributes.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedDemoAttributes } from './seed/demoAttributes';

const prisma = new PrismaClient();

async function main() {
  const r = await seedDemoAttributes(prisma);
  console.log(`[demo attributes] products filled: ${r.filled} of ${r.empty} demo products without a spec sheet (${r.rows} rows)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
