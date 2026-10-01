import { Prisma, type PrismaClient } from '@prisma/client';
import { normaliseAttributes } from '@clowe/shared';
import { loadCategoryLookup } from './categoryRulesLookup';

export interface AttributeKeyBackfillReport {
  /** Products that had any attribute rows at all. */
  checked: number;
  /** Products whose stored rows were rewritten. */
  productsChanged: number;
  /** Rows written in those products. */
  rowsWritten: number;
  /** Rows the column held that could not be rendered and were dropped. */
  rowsDropped: number;
}

/**
 * Rewrite every stored spec sheet into canonical { key, label, value } rows,
 * keying rule fields from the product's resolved category rules. A sheet
 * already in that shape is left alone, which is what makes a second run a
 * no-op.
 */
export async function backfillAttributeKeys(prisma: PrismaClient): Promise<AttributeKeyBackfillReport> {
  const { rulesById } = await loadCategoryLookup(prisma);
  const products = await prisma.product.findMany({
    where: { attributes: { not: Prisma.AnyNull } },
    select: { id: true, categoryId: true, attributes: true },
  });
  const report: AttributeKeyBackfillReport = { checked: 0, productsChanged: 0, rowsWritten: 0, rowsDropped: 0 };
  for (const product of products) {
    if (!Array.isArray(product.attributes) || product.attributes.length === 0) continue;
    report.checked += 1;
    const defs = rulesById.get(product.categoryId)?.attributeSchema ?? [];
    const canonical = normaliseAttributes(product.attributes, defs);
    if (JSON.stringify(canonical) === JSON.stringify(product.attributes)) continue;
    await prisma.product.update({ where: { id: product.id }, data: { attributes: canonical } });
    report.productsChanged += 1;
    report.rowsWritten += canonical.length;
    report.rowsDropped += product.attributes.length - canonical.length;
  }
  return report;
}
