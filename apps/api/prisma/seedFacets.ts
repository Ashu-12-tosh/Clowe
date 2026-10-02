/**
 * Give every category its starting filter facets (prisma/seed/facets.ts).
 *
 * Only categories with no facets of their own are written, so anything an
 * admin has edited stays as it is; a category with no seed entry inherits its
 * parent's set. Prints every category's resolved facets, and any category the
 * seed does not know by slug — on a database whose tree differs from the
 * seed's, those are the ones to look at.
 *
 * Dry run by default; pass --apply to write. Safe to re-run.
 *
 *   dc exec api npx tsx prisma/seedFacets.ts [--apply]                 # production
 *   npm run db:seed-facets --workspace=@clowe/api [-- --apply]        # dev checkout only
 *
 * npm run fails on the server (tsx: not found): the image prunes dev dependencies.
 */
// env first: it layers .env.local over .env, and nothing may load .env before it.
import '../src/env';
import { prisma } from '../src/db';
import { seedCategoryFacets, seededFacetTable } from './seed/facets';

async function main() {
  const apply = process.argv.includes('--apply');
  const report = await seedCategoryFacets(prisma, apply);
  console.log(`[facets] ${apply ? 'Wrote' : 'Would write'} ${report.written.length} categories; kept ${report.kept.length} that already have their own.`);
  if (report.inheriting.length) {
    console.log(`[facets] No seed entry, so they inherit their parent's set: ${report.inheriting.join(', ')}`);
  }
  if (report.unknownSlugs.length) {
    console.log(`[facets] Seed entries for categories this database does not have: ${report.unknownSlugs.join(', ')}`);
  }
  console.log('\nResolved facets per category (as seeded):');
  for (const row of await seededFacetTable(prisma)) {
    console.log(`  ${row.path} [${row.slug}]: ${row.facets.join(', ') || '(common facets only)'}`);
  }
  if (!apply) console.log('\nDry run. Pass --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
