import type { PrismaClient } from '@prisma/client';
import { categoryRuleFieldsFromRow, resolveCategoryRules, type CategoryRules } from '@clowe/shared';

/**
 * Category rules resolved for every category, from one read of the tree.
 *
 * The API resolves rules through its own cached service; seeds and one-off
 * scripts run outside the app with their own PrismaClient, so they read the
 * tree once here and look rules up by category id.
 */
export interface CategoryLookup {
  rulesById: Map<string, CategoryRules>;
  slugById: Map<string, string>;
  /** Top-level ancestor's slug for each category, e.g. "fashion" for "fashion-men". */
  rootSlugById: Map<string, string>;
}

export async function loadCategoryLookup(prisma: PrismaClient): Promise<CategoryLookup> {
  const rows = await prisma.category.findMany({
    select: {
      id: true,
      parentId: true,
      slug: true,
      variantAxes: true,
      attributeSchema: true,
      tryOnEligible: true,
      sizeGuide: true,
      taxRule: true,
      defaultTaxRatePercent: true,
      hsnCode: true,
      returnWindowDays: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rulesById = new Map<string, CategoryRules>();
  const slugById = new Map<string, string>();
  const rootSlugById = new Map<string, string>();
  for (const row of rows) {
    // [category, parent, …, root]; the seen-set guards against a cycle an
    // admin edit could have introduced.
    const chain: typeof rows = [];
    const seen = new Set<string>();
    let current: (typeof rows)[number] | undefined = row;
    while (current && !seen.has(current.id)) {
      chain.push(current);
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    rulesById.set(row.id, resolveCategoryRules(chain.map(categoryRuleFieldsFromRow)));
    slugById.set(row.id, row.slug);
    rootSlugById.set(row.id, chain[chain.length - 1].slug);
  }
  return { rulesById, slugById, rootSlugById };
}
