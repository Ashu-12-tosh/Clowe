/**
 * Fill the demo catalog's filter-facet values its spec sheets never had (see
 * prisma/seed/demoFacetValues.ts), and print facet coverage per category
 * before and after: for every category with live products, how many carry a
 * value for each of its facets.
 *
 * Demo products only, and only facets a product has no value for. Dry run by
 * default; pass --apply to write. Safe to re-run: a second run writes nothing.
 *
 *   dc exec api npx tsx prisma/backfillDemoFacets.ts [--apply]                 # production
 *   npm run db:backfill-demo-facets --workspace=@clowe/api [-- --apply]        # dev checkout only
 *
 * npm run fails on the server (tsx: not found): the image prunes dev dependencies.
 */
// env first: it layers .env.local over .env, and nothing may load .env before it.
import '../src/env';
import { prisma } from '../src/db';
import { facetCoverage, seedDemoFacetValues, type FacetCoverageRow } from './seed/demoFacetValues';

function print(rows: FacetCoverageRow[]) {
  for (const row of rows) {
    const cells = row.facets.map((f) => `${f.label} ${f.withValue}/${row.products}`);
    console.log(`  ${row.path} (${row.products}): ${cells.join(' · ') || '(common facets only)'}`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log('Facet coverage before:');
  print(await facetCoverage(prisma));
  const report = await seedDemoFacetValues(prisma, apply);
  const total = Object.values(report.values).reduce((a, b) => a + b, 0);
  console.log(`\n[demo-facets] ${apply ? 'Wrote' : 'Would write'} ${total} values on ${report.products} demo products:`);
  console.log(`  ${Object.entries(report.values).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (apply) {
    console.log('\nFacet coverage after:');
    print(await facetCoverage(prisma));
  } else {
    console.log('\nDry run. Pass --apply to write.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
