// Try-on needs two things a fresh catalog does not get by default: products
// opted in (Product.tryOnEnabled defaults to false since 20260901, because a
// seller pays per run and must choose to) and a seller with credits to pay
// for runs (SellerProfile.tryOnCredits defaults to 0; the signup route grants
// the first 100 shops 50 free runs). The seed set neither, so every fashion
// product on a freshly seeded site — production included — hid "Try On Me".
//
// Both helpers are used by the seed and by the one-off backfill
// (prisma/backfillTryOn.ts), so there is one definition of "eligible" and it
// is the same one the product endpoint applies: the category chain's
// tryOnEligible rule, resolved nearest-first, and the garment not being one
// try-on must refuse.
import type { PrismaClient } from '@prisma/client';
import { resolveCategoryRules, type CategoryRuleFields } from '@clowe/shared';
import { isSensitiveForTryOn } from '../../src/services/tryon/sensitiveGarment';

const RULE_FIELDS = {
  variantAxes: true,
  attributeSchema: true,
  tryOnEligible: true,
  sizeGuide: true,
  taxRule: true,
  defaultTaxRatePercent: true,
  hsnCode: true,
  returnWindowDays: true,
} as const;

/** Which categories allow try-on, resolved along each one's parent chain. */
async function tryOnEligibleCategories(prisma: PrismaClient): Promise<Set<string>> {
  const rows = await prisma.category.findMany({
    select: { id: true, parentId: true, ...RULE_FIELDS },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const eligible = new Set<string>();
  for (const row of rows) {
    const chain: CategoryRuleFields[] = [];
    for (let node: (typeof row) | undefined = row; node; node = node.parentId ? byId.get(node.parentId) : undefined) {
      chain.push(node as unknown as CategoryRuleFields);
    }
    if (resolveCategoryRules(chain).tryOnEligible) eligible.add(row.id);
  }
  return eligible;
}

/**
 * Opt in every product that try-on could work on and that is not opted in.
 *
 * Only ever turns the flag on. It cannot tell a seller's deliberate opt-out
 * from the default, so it is for catalogs where no seller has chosen yet —
 * a fresh seed, or the demo catalog already live.
 */
export async function enableTryOnWhereEligible(
  prisma: PrismaClient,
): Promise<{ checked: number; enabled: number }> {
  const eligible = await tryOnEligibleCategories(prisma);
  const candidates = await prisma.product.findMany({
    where: { tryOnEnabled: false },
    select: { id: true, title: true, categoryId: true, category: { select: { name: true } } },
  });
  const ids = candidates
    .filter((p) => eligible.has(p.categoryId) && !isSensitiveForTryOn(p.category.name, p.title))
    .map((p) => p.id);
  if (ids.length > 0) {
    await prisma.product.updateMany({ where: { id: { in: ids } }, data: { tryOnEnabled: true } });
  }
  return { checked: candidates.length, enabled: ids.length };
}

/**
 * The launch offer the signup route gives real shops — 50 free runs to the
 * first 100 — applied to a seller the seed or a backfill created instead.
 * Returns false if this seller already had it, or the offer is used up.
 */
export async function grantLaunchTryOns(prisma: PrismaClient, sellerId: string): Promise<boolean> {
  const seller = await prisma.sellerProfile.findUnique({
    where: { id: sellerId },
    select: { tryOnFreeGrant: true },
  });
  if (!seller || seller.tryOnFreeGrant) return false;
  const granted = await prisma.sellerProfile.count({ where: { tryOnFreeGrant: true } });
  if (granted >= 100) return false;
  await prisma.$transaction([
    prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { tryOnFreeGrant: true, tryOnCredits: { increment: 50 } },
    }),
    prisma.tryOnCreditLedger.create({
      data: { sellerId, delta: 50, reason: 'FREE_GRANT', note: 'Early-seller launch offer' },
    }),
  ]);
  return true;
}
