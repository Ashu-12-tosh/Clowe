// Link every product that names its brand in text to a Brand row.
//
// Why: 17 products on the demo catalog carry `brand` text (CasaWear, DenimCo,
// Rangreza — the original clothing seed, before brands were rows) but no
// brandId, so a brand facet keyed on the id misses them and a brand page
// cannot find them. Every seed since creates the row and the link together.
//
// What it does: for each distinct brand name on an unlinked product, finds a
// Brand whose name matches case-insensitively (or whose slug the name slugs
// to) and creates one when there is none, then points the products at it.
// Products already linked are not touched, so a second run links 0.
//
// Run with: npm run db:backfill-brand-ids --workspace=@clowe/api
// On the server: dc exec api npx tsx prisma/backfillBrandIds.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { backfillBrandIds } from './seed/brandIds';

const prisma = new PrismaClient();

async function main() {
  const r = await backfillBrandIds(prisma);
  console.log(
    `[brands] ${r.names} brand name(s) on unlinked products: ${r.matched} matched an existing brand, ` +
      `${r.created} created; ${r.productsLinked} product(s) linked`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
