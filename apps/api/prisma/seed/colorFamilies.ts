import type { PrismaClient } from '@prisma/client';
import { colorFamilyOf, optionValuesFromJson, withDerivedOptions } from '@clowe/shared';

export interface ColorFamilyBackfillReport {
  /** Variants whose option map names a colour. */
  checked: number;
  /** Variants whose stored map was rewritten (family added, corrected or removed). */
  updated: number;
  /** Distinct colour names no family could be found for, with how many variants carry each. */
  unmatched: Map<string, number>;
}

/**
 * Write optionValues.color_family on every variant that has a colour, the
 * same way the API does on save. A variant whose family is already right is
 * left alone, which is what makes a second run a no-op; a colour the shared
 * lookup does not know is reported rather than guessed.
 */
export async function backfillColorFamilies(prisma: PrismaClient): Promise<ColorFamilyBackfillReport> {
  const variants = await prisma.productVariant.findMany({ select: { id: true, optionValues: true } });
  const report: ColorFamilyBackfillReport = { checked: 0, updated: 0, unmatched: new Map() };
  for (const variant of variants) {
    const stored =
      variant.optionValues && typeof variant.optionValues === 'object' && !Array.isArray(variant.optionValues)
        ? (variant.optionValues as Record<string, unknown>)
        : {};
    // The read strips derived keys, so `wanted` is exactly what a fresh save would store.
    const axes = optionValuesFromJson(stored);
    if (!axes.color) continue;
    report.checked += 1;
    if (colorFamilyOf(axes.color) === null) {
      report.unmatched.set(axes.color, (report.unmatched.get(axes.color) ?? 0) + 1);
    }
    const wanted = withDerivedOptions(axes);
    if (stored.color_family === wanted.color_family) continue;
    await prisma.productVariant.update({ where: { id: variant.id }, data: { optionValues: wanted } });
    report.updated += 1;
  }
  return report;
}
