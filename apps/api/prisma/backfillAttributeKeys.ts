// Give every stored spec-sheet row the key a filter can read.
//
// Why: Product.attributes grew up as [{ name, value }] — the label a seller
// typed and nothing else — while the category rules declare each field under
// a stable key ("country_of_origin"). The facet work needs the key: "Fabric",
// "fabric" and "FABRIC " are one field, and grouping by typed label cannot
// know that. Since BF1 the API stores { key, label, value } on every save,
// but a listing nobody re-saves keeps its old rows forever.
//
// What it does: for each product with attributes, resolves the category rules
// along the parent chain and rewrites the rows in the canonical shape — rule
// fields take the rule's key and label, custom rows get a key derived from
// their label, and junk the UI could never render is dropped. Rows already
// canonical are untouched. Safe to re-run: a second run reports 0 changed.
//
// Run with: npm run db:backfill-attribute-keys --workspace=@clowe/api
// On the server: dc exec api npx tsx prisma/backfillAttributeKeys.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { backfillAttributeKeys } from './seed/attributeKeys';

const prisma = new PrismaClient();

async function main() {
  const r = await backfillAttributeKeys(prisma);
  console.log(
    `[attributes] products rewritten: ${r.productsChanged} of ${r.checked} with a spec sheet ` +
      `(${r.rowsWritten} rows written, ${r.rowsDropped} junk or duplicate rows dropped)`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
