import type { PrismaClient } from '@prisma/client';

export interface BrandIdBackfillReport {
  /** Distinct brand names found on products with no brandId. */
  names: number;
  /** Of those, matched to a Brand that already existed. */
  matched: number;
  /** Of those, given a new Brand row. */
  created: number;
  /** Products that now point at a brand. */
  productsLinked: number;
}

/** The seeds' spelling of a brand slug, so a brand created here is the one a later re-seed upserts into. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** After every seeded brand (they take 100–299), so the brand rail keeps its curated order. */
const BACKFILLED_BRAND_SORT_ORDER = 900;

/**
 * Point every product that names a brand in text at a Brand row: an existing
 * one whose name matches case-insensitively (or whose slug the name slugs
 * to), else a new one. Products already linked are not touched, which is
 * what makes a second run link 0.
 */
export async function backfillBrandIds(prisma: PrismaClient): Promise<BrandIdBackfillReport> {
  const unlinked = await prisma.product.findMany({
    where: { brandId: null, brand: { not: null } },
    select: { brand: true },
    distinct: ['brand'],
  });
  const report: BrandIdBackfillReport = { names: 0, matched: 0, created: 0, productsLinked: 0 };
  for (const { brand } of unlinked) {
    const name = brand?.trim();
    if (!name) continue;
    report.names += 1;
    const slug = slugify(name);
    let row = await prisma.brand.findFirst({
      where: { OR: [{ name: { equals: name, mode: 'insensitive' } }, { slug }] },
    });
    if (row) {
      report.matched += 1;
    } else {
      row = await prisma.brand.create({ data: { name, slug, sortOrder: BACKFILLED_BRAND_SORT_ORDER } });
      report.created += 1;
    }
    const { count } = await prisma.product.updateMany({
      where: { brandId: null, brand: { equals: name, mode: 'insensitive' } },
      data: { brandId: row.id },
    });
    report.productsLinked += count;
  }
  return report;
}
