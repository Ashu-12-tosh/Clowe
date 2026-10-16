import {
  DEFAULT_COMMERCIAL,
  mergeCommercial,
  placementPriceProblems,
  type CommercialSettings,
  type SellerFeesV2,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';

// ---------------------------------------------------------------------------
// The owner's commercial rules (Batch 2), as one platform setting: read with
// every field defaulted, written only whole and valid.
// ---------------------------------------------------------------------------

export const COMMERCIAL_KEY = 'commercial';

/** The rules in force: what admin saved, over the defaults (a field added later gets its default). */
export async function getCommercial(): Promise<CommercialSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: COMMERCIAL_KEY } });
  if (!row?.value || typeof row.value !== 'object') return DEFAULT_COMMERCIAL;
  try {
    return mergeCommercial(DEFAULT_COMMERCIAL, row.value as Record<string, unknown>);
  } catch (err) {
    console.error('[clowe-api] stored commercial rules are invalid; using the defaults:', err instanceof Error ? err.message : err);
    return DEFAULT_COMMERCIAL;
  }
}

/** Apply a partial change now. Refused whole if the result is invalid or a placement price leaves its range. */
export async function updateCommercial(patch: Record<string, unknown>): Promise<CommercialSettings> {
  let next: CommercialSettings;
  try {
    next = mergeCommercial(await getCommercial(), patch);
  } catch (err) {
    throw ApiError.badRequest(`Not saved: ${err instanceof Error ? err.message.slice(0, 300) : 'invalid rules'}`, 'COMMERCIAL_INVALID');
  }
  const problems = placementPriceProblems(next);
  if (problems.length) throw ApiError.badRequest(problems.join('; '), 'PRICE_OUT_OF_RANGE');
  await prisma.platformSetting.upsert({
    where: { key: COMMERCIAL_KEY },
    update: { value: next as unknown as object },
    create: { key: COMMERCIAL_KEY, value: next as unknown as object },
  });
  return next;
}

/** Whether a seller pays no handling fee: the admin's VIP flag, or the Premium plan. */
export async function handlingWaivedFor(sellerIds: string[]): Promise<Map<string, boolean>> {
  const c = await getCommercial();
  const sellers = await prisma.sellerProfile.findMany({
    where: { id: { in: [...new Set(sellerIds)] } },
    select: { id: true, vip: true, subscription: { select: { plan: true } } },
  });
  return new Map(
    sellers.map((s) => {
      const plan = s.subscription?.plan ?? 'FREE';
      return [s.id, s.vip || c.plans[plan].waivesHandlingFee];
    }),
  );
}

/**
 * The fees a new order line is sold under, fixed at checkout: the category's
 * referral fee, the GT and collection percents, the handling slabs, the GST on
 * Clowe's charges, and whether the seller's handling fee is waived.
 */
export async function feeSnapshots(lines: { productId: string; sellerId: string }[]): Promise<Map<string, SellerFeesV2>> {
  const c = await getCommercial();
  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.productId))] } },
    select: { id: true, sellerId: true, category: { select: { referralPercent: true } } },
  });
  const waived = await handlingWaivedFor(products.map((p) => p.sellerId));
  return new Map(
    products.map((p) => [
      p.id,
      {
        referralPercent: p.category.referralPercent,
        gtPercent: c.fees.gtPercent,
        collectionPercent: c.fees.collectionPercent,
        handlingSlabs: c.fees.handlingSlabs,
        handlingWaived: waived.get(p.sellerId) ?? false,
        gstPercent: c.fees.gstPercent,
      },
    ]),
  );
}
