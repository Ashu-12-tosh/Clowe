import type { Promotion } from '@prisma/client';
import { prisma } from '../db';

// ---------------------------------------------------------------------------
// Seller promotions.
//
// A promotion discounts the seller's own lines. The discount is taken off the
// line price at checkout, so the order, the invoice, the refund and the
// seller's payout all agree on what the shopper actually paid.
// ---------------------------------------------------------------------------

/** What the engine needs to know about a cart line. */
export interface PromotableLine {
  variantId: string;
  productId: string;
  sellerId: string;
  categoryId: string;
  /** Root category, so a CATEGORY promotion can target a department. */
  rootCategoryId: string;
  pricePaise: number;
  quantity: number;
}

export interface LinePromotion {
  promotionId: string;
  name: string;
  code: string | null;
  discountPaise: number;
}

export type PromotionsByVariant = Map<string, LinePromotion>;

/** Live promotions belonging to these sellers, right now. */
export async function runningPromotions(sellerIds: string[]): Promise<Promotion[]> {
  if (sellerIds.length === 0) return [];
  const now = new Date();
  return prisma.promotion.findMany({
    where: {
      sellerId: { in: sellerIds },
      state: 'ACTIVE',
      startAt: { lte: now },
      endAt: { gte: now },
    },
    orderBy: { createdAt: 'asc' },
  });
}

function targetsLine(promotion: Promotion, line: PromotableLine): boolean {
  if (promotion.sellerId !== line.sellerId) return false;
  switch (promotion.scope) {
    case 'PRODUCT':
      return promotion.productIds.includes(line.productId);
    case 'CATEGORY':
      return (
        promotion.categoryIds.includes(line.categoryId) ||
        promotion.categoryIds.includes(line.rootCategoryId)
      );
    default:
      return true;
  }
}

/** Raw discount on an eligible subtotal, before the per-promotion cap. */
function rawDiscount(promotion: Promotion, subtotalPaise: number): number {
  const raw =
    promotion.kind === 'PERCENT'
      ? Math.floor((subtotalPaise * promotion.value) / 100)
      : promotion.value;
  const capped = promotion.maxDiscountPaise ? Math.min(raw, promotion.maxDiscountPaise) : raw;
  // Never discount below zero, and never more than the goods are worth.
  return Math.max(0, Math.min(capped, subtotalPaise));
}

/**
 * Spread a promotion's discount across its lines in proportion to their
 * value. Each line's share is rounded down to a whole per-unit amount, so the
 * shopper is never over-discounted and the order line keeps an integer price.
 */
function distribute(
  discountPaise: number,
  lines: { line: PromotableLine; totalPaise: number }[],
): Map<string, number> {
  const out = new Map<string, number>();
  const eligibleTotal = lines.reduce((sum, l) => sum + l.totalPaise, 0);
  if (eligibleTotal <= 0 || discountPaise <= 0) return out;

  for (const entry of lines) {
    const share = Math.floor((discountPaise * entry.totalPaise) / eligibleTotal);
    // Round down to a whole per-unit amount: the order line stores a unit
    // price, so a discount that doesn't divide by quantity can't be charged.
    const perUnit = Math.floor(share / entry.line.quantity);
    out.set(entry.line.variantId, perUnit * entry.line.quantity);
  }
  return out;
}

/** How many times this shopper has already redeemed a promotion. */
async function redemptionCounts(
  promotionIds: string[],
  userId: string,
): Promise<Map<string, number>> {
  if (promotionIds.length === 0) return new Map();
  const rows = await prisma.promotionRedemption.groupBy({
    by: ['promotionId'],
    where: { promotionId: { in: promotionIds }, userId },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.promotionId, r._count._all]));
}

/**
 * Best promotion per seller for this cart. Automatic promotions always
 * compete; coded ones only when the shopper entered that code. One promotion
 * wins per seller — the one that saves the shopper the most.
 */
export async function applyPromotions(
  lines: PromotableLine[],
  options: { userId: string; enteredCode?: string | null },
): Promise<PromotionsByVariant> {
  const result: PromotionsByVariant = new Map();
  if (lines.length === 0) return result;

  const sellerIds = [...new Set(lines.map((l) => l.sellerId))];
  const promotions = await runningPromotions(sellerIds);
  if (promotions.length === 0) return result;

  const entered = options.enteredCode?.trim().toUpperCase() ?? null;
  const usable = promotions.filter((p) => !p.code || p.code.toUpperCase() === entered);
  if (usable.length === 0) return result;

  const mine = await redemptionCounts(
    usable.map((p) => p.id),
    options.userId,
  );

  for (const sellerId of sellerIds) {
    const sellerLines = lines.filter((l) => l.sellerId === sellerId);
    let best: { promotion: Promotion; spread: Map<string, number>; total: number } | null = null;

    for (const promotion of usable.filter((p) => p.sellerId === sellerId)) {
      if (promotion.usageLimit !== null && promotion.usedCount >= promotion.usageLimit) continue;
      if (
        promotion.perUserLimit !== null &&
        (mine.get(promotion.id) ?? 0) >= promotion.perUserLimit
      ) {
        continue;
      }

      const eligible = sellerLines
        .filter((line) => targetsLine(promotion, line))
        .map((line) => ({ line, totalPaise: line.pricePaise * line.quantity }));
      const eligibleTotal = eligible.reduce((sum, e) => sum + e.totalPaise, 0);
      if (eligibleTotal <= 0 || eligibleTotal < promotion.minOrderPaise) continue;

      const discount = rawDiscount(promotion, eligibleTotal);
      if (discount <= 0) continue;
      if (!best || discount > best.total) {
        best = { promotion, spread: distribute(discount, eligible), total: discount };
      }
    }

    if (!best) continue;
    for (const [variantId, discountPaise] of best.spread) {
      if (discountPaise <= 0) continue;
      result.set(variantId, {
        promotionId: best.promotion.id,
        name: best.promotion.name,
        code: best.promotion.code,
        discountPaise,
      });
    }
  }

  return result;
}

/**
 * Record redemptions once an order is placed: one row per promotion, with the
 * gross it applied to. Also bumps the counters the seller's list reads.
 */
export async function recordRedemptions(
  tx: Pick<typeof prisma, 'promotionRedemption' | 'promotion'>,
  input: {
    orderId: string;
    userId: string;
    lines: { promotionId: string | null; promoDiscountPaise: number; grossPaise: number }[];
  },
): Promise<void> {
  const byPromotion = new Map<string, { grossPaise: number; discountPaise: number }>();
  for (const line of input.lines) {
    if (!line.promotionId || line.promoDiscountPaise <= 0) continue;
    const entry = byPromotion.get(line.promotionId) ?? { grossPaise: 0, discountPaise: 0 };
    entry.grossPaise += line.grossPaise;
    entry.discountPaise += line.promoDiscountPaise;
    byPromotion.set(line.promotionId, entry);
  }

  for (const [promotionId, totals] of byPromotion) {
    await tx.promotionRedemption.create({
      data: {
        promotionId,
        orderId: input.orderId,
        userId: input.userId,
        grossPaise: totals.grossPaise,
        discountPaise: totals.discountPaise,
      },
    });
    await tx.promotion.update({
      where: { id: promotionId },
      data: {
        usedCount: { increment: 1 },
        discountGivenPaise: { increment: totals.discountPaise },
      },
    });
  }
}

/** Display status derived from the seller's setting plus the clock. */
export function promotionStatus(promotion: {
  state: string;
  startAt: Date;
  endAt: Date;
  usageLimit: number | null;
  usedCount: number;
}): 'DRAFT' | 'PAUSED' | 'SCHEDULED' | 'RUNNING' | 'EXPIRED' {
  if (promotion.state === 'DRAFT') return 'DRAFT';
  if (promotion.state === 'PAUSED') return 'PAUSED';
  const now = new Date();
  if (promotion.endAt < now) return 'EXPIRED';
  if (promotion.usageLimit !== null && promotion.usedCount >= promotion.usageLimit) {
    return 'EXPIRED';
  }
  if (promotion.startAt > now) return 'SCHEDULED';
  return 'RUNNING';
}
