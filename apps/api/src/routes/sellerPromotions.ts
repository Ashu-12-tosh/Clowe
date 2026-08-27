import { Router } from 'express';
import { z } from 'zod';
import type { Prisma, Promotion } from '@prisma/client';
import {
  PROMOTION_SCOPE_LABELS,
  PROMOTION_TABS,
  promotionStateSchema,
  promotionUpsertSchema,
  type PromotionScopeValue,
  type PromotionKindValue,
  type PromotionTab,
  type SellerPromotionDetail,
  type SellerPromotionPage,
  type SellerPromotionRow,
  type SellerPromotionSummary,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { promotionStatus } from '../services/promotionService';
import { requireSeller } from './seller';

export const sellerPromotionsRouter = Router();
sellerPromotionsRouter.use(requireAuth, requireSeller);

const listQuery = z.object({
  tab: z.enum(PROMOTION_TABS).default('ALL'),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
});

type PromotionRecord = Promotion & {
  redemptions?: { grossPaise: number; discountPaise: number }[];
};

/** Sales and order counts per promotion, from the redemption trail. */
async function performanceByPromotion(
  sellerId: string,
): Promise<Map<string, { salesPaise: number; orderCount: number; discountPaise: number }>> {
  const rows = await prisma.promotionRedemption.groupBy({
    by: ['promotionId'],
    where: { promotion: { sellerId } },
    _sum: { grossPaise: true, discountPaise: true },
    _count: { _all: true },
  });
  return new Map(
    rows.map((r) => [
      r.promotionId,
      {
        salesPaise: r._sum.grossPaise ?? 0,
        discountPaise: r._sum.discountPaise ?? 0,
        orderCount: r._count._all,
      },
    ]),
  );
}

function toRow(
  promotion: PromotionRecord,
  performance: { salesPaise: number; orderCount: number } | undefined,
): SellerPromotionRow {
  const salesGeneratedPaise = performance?.salesPaise ?? 0;
  return {
    id: promotion.id,
    name: promotion.name,
    description: promotion.description,
    code: promotion.code,
    scope: promotion.scope as PromotionScopeValue,
    scopeLabel: PROMOTION_SCOPE_LABELS[promotion.scope as PromotionScopeValue],
    kind: promotion.kind as PromotionKindValue,
    value: promotion.value,
    maxDiscountPaise: promotion.maxDiscountPaise,
    minOrderPaise: promotion.minOrderPaise,
    startAt: promotion.startAt.toISOString(),
    endAt: promotion.endAt.toISOString(),
    usageLimit: promotion.usageLimit,
    perUserLimit: promotion.perUserLimit,
    usedCount: promotion.usedCount,
    discountGivenPaise: promotion.discountGivenPaise,
    salesGeneratedPaise,
    orderCount: performance?.orderCount ?? 0,
    roi:
      promotion.discountGivenPaise > 0
        ? Math.round((salesGeneratedPaise / promotion.discountGivenPaise) * 100) / 100
        : null,
    status: promotionStatus(promotion),
    isFeatured: promotion.isFeatured,
    productIds: promotion.productIds,
    categoryIds: promotion.categoryIds,
    createdAt: promotion.createdAt.toISOString(),
    updatedAt: promotion.updatedAt.toISOString(),
  };
}

/** Status is derived, so the tab filter is applied after mapping. */
function matchesTab(row: SellerPromotionRow, tab: PromotionTab): boolean {
  switch (tab) {
    case 'RUNNING':
      return row.status === 'RUNNING';
    case 'SCHEDULED':
      return row.status === 'SCHEDULED';
    case 'EXPIRED':
      return row.status === 'EXPIRED';
    case 'DRAFT':
      return row.status === 'DRAFT';
    default:
      return true;
  }
}

async function loadRows(sellerId: string, q?: string): Promise<SellerPromotionRow[]> {
  const [promotions, performance] = await Promise.all([
    prisma.promotion.findMany({
      where: {
        sellerId,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { code: { contains: q.toUpperCase() } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
    }),
    performanceByPromotion(sellerId),
  ]);
  return promotions.map((p) => toRow(p, performance.get(p.id)));
}

// ---------------------------------------------------------------------------
// GET / — the promotions table
// ---------------------------------------------------------------------------

sellerPromotionsRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const rows = (await loadRows(req.seller!.id, query.q)).filter((r) => matchesTab(r, query.tab));

    const body: SellerPromotionPage = {
      rows: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(rows.length / query.pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /summary — KPIs, performance split, top promotions
// ---------------------------------------------------------------------------

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

sellerPromotionsRouter.get('/summary', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [rows, redemptions] = await Promise.all([
      loadRows(sellerId),
      prisma.promotionRedemption.findMany({
        where: { promotion: { sellerId }, createdAt: { gte: prevMonthStart } },
        select: { grossPaise: true, discountPaise: true, createdAt: true },
      }),
    ]);

    const thisMonth = redemptions.filter((r) => r.createdAt >= monthStart);
    const lastMonth = redemptions.filter((r) => r.createdAt < monthStart);
    const sum = (list: typeof redemptions, key: 'grossPaise' | 'discountPaise') =>
      list.reduce((total, r) => total + r[key], 0);

    const discountGivenPaise = rows.reduce((total, r) => total + r.discountGivenPaise, 0);
    const salesFromPromotionsPaise = rows.reduce((total, r) => total + r.salesGeneratedPaise, 0);

    // Sales split by what the promotion targeted.
    const byScope = new Map<string, number>();
    for (const row of rows) {
      byScope.set(row.scope, (byScope.get(row.scope) ?? 0) + row.salesGeneratedPaise);
    }

    const counts = Object.fromEntries(
      PROMOTION_TABS.map((tab) => [tab, rows.filter((r) => matchesTab(r, tab)).length]),
    ) as Record<PromotionTab, number>;

    const body: SellerPromotionSummary = {
      kpis: {
        active: rows.filter((r) => r.status === 'RUNNING').length,
        newThisMonth: rows.filter((r) => new Date(r.createdAt) >= monthStart).length,
        redemptions: rows.reduce((total, r) => total + r.usedCount, 0),
        redemptionsChangePercent: changePercent(thisMonth.length, lastMonth.length),
        discountGivenPaise,
        discountChangePercent: changePercent(
          sum(thisMonth, 'discountPaise'),
          sum(lastMonth, 'discountPaise'),
        ),
        salesFromPromotionsPaise,
        salesChangePercent: changePercent(
          sum(thisMonth, 'grossPaise'),
          sum(lastMonth, 'grossPaise'),
        ),
        roi:
          discountGivenPaise > 0
            ? Math.round((salesFromPromotionsPaise / discountGivenPaise) * 100) / 100
            : null,
      },
      performance: [...byScope.entries()]
        .map(([key, amountPaise]) => ({
          key,
          label: PROMOTION_SCOPE_LABELS[key as PromotionScopeValue],
          amountPaise,
          share:
            salesFromPromotionsPaise > 0
              ? Math.round((amountPaise / salesFromPromotionsPaise) * 1000) / 10
              : 0,
        }))
        .filter((p) => p.amountPaise > 0)
        .sort((a, b) => b.amountPaise - a.amountPaise),
      topPromotions: [...rows]
        .sort((a, b) => b.salesGeneratedPaise - a.salesGeneratedPaise)
        .filter((r) => r.salesGeneratedPaise > 0)
        .slice(0, 3)
        .map((r) => ({
          id: r.id,
          name: r.name,
          code: r.code,
          salesPaise: r.salesGeneratedPaise,
          orderCount: r.orderCount,
        })),
      counts,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Create / update / state / delete
// ---------------------------------------------------------------------------

function dataFrom(input: z.infer<typeof promotionUpsertSchema>): Prisma.PromotionUncheckedCreateInput {
  return {
    sellerId: '', // set by the caller
    name: input.name,
    description: input.description?.trim() || null,
    code: input.code ? input.code.toUpperCase() : null,
    scope: input.scope,
    kind: input.kind,
    value: input.value,
    maxDiscountPaise: input.maxDiscountPaise ?? null,
    minOrderPaise: input.minOrderPaise,
    startAt: new Date(input.startAt),
    endAt: new Date(input.endAt),
    usageLimit: input.usageLimit ?? null,
    perUserLimit: input.perUserLimit ?? null,
    productIds: input.scope === 'PRODUCT' ? input.productIds : [],
    categoryIds: input.scope === 'CATEGORY' ? input.categoryIds : [],
    isFeatured: input.isFeatured,
    state: input.state,
  };
}

/** Targets must belong to this seller — no discounting someone else's goods. */
async function assertOwnTargets(
  sellerId: string,
  input: z.infer<typeof promotionUpsertSchema>,
): Promise<void> {
  if (input.scope === 'PRODUCT' && input.productIds.length > 0) {
    const mine = await prisma.product.count({
      where: { id: { in: input.productIds }, sellerId },
    });
    if (mine !== input.productIds.length) {
      throw ApiError.badRequest('Some selected products are not yours', 'INVALID_TARGETS');
    }
  }
  if (input.scope === 'CATEGORY' && input.categoryIds.length > 0) {
    const known = await prisma.category.count({ where: { id: { in: input.categoryIds } } });
    if (known !== input.categoryIds.length) {
      throw ApiError.badRequest('Some selected categories no longer exist', 'INVALID_TARGETS');
    }
  }
}

sellerPromotionsRouter.post('/', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const input = promotionUpsertSchema.parse(req.body);
    await assertOwnTargets(sellerId, input);

    if (input.code) {
      const clash = await prisma.promotion.findUnique({ where: { code: input.code.toUpperCase() } });
      const couponClash = await prisma.coupon.findUnique({
        where: { code: input.code.toUpperCase() },
      });
      if (clash || couponClash) {
        throw ApiError.badRequest('That code is already in use', 'CODE_TAKEN');
      }
    }

    const created = await prisma.promotion.create({
      data: { ...dataFrom(input), sellerId },
    });
    res.json({ success: true, data: toRow(created, undefined) });
  } catch (err) {
    next(err);
  }
});

sellerPromotionsRouter.put('/:id', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const existing = await prisma.promotion.findFirst({ where: { id: req.params.id, sellerId } });
    if (!existing) throw ApiError.notFound('Promotion not found');

    const input = promotionUpsertSchema.parse(req.body);
    await assertOwnTargets(sellerId, input);

    const nextCode = input.code ? input.code.toUpperCase() : null;
    if (nextCode && nextCode !== existing.code) {
      const clash = await prisma.promotion.findUnique({ where: { code: nextCode } });
      const couponClash = await prisma.coupon.findUnique({ where: { code: nextCode } });
      if (clash || couponClash) throw ApiError.badRequest('That code is already in use', 'CODE_TAKEN');
    }

    // sellerId is dropped on purpose: a promotion can never be moved to
    // another shop by editing it.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { sellerId: _ignored, ...data } = dataFrom(input);
    const updated = await prisma.promotion.update({ where: { id: existing.id }, data });
    const performance = await performanceByPromotion(sellerId);
    res.json({ success: true, data: toRow(updated, performance.get(updated.id)) });
  } catch (err) {
    next(err);
  }
});

/** Pause / resume / move back to draft. */
sellerPromotionsRouter.patch('/:id/state', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const { state } = promotionStateSchema.parse(req.body);
    const existing = await prisma.promotion.findFirst({ where: { id: req.params.id, sellerId } });
    if (!existing) throw ApiError.notFound('Promotion not found');

    const updated = await prisma.promotion.update({ where: { id: existing.id }, data: { state } });
    const performance = await performanceByPromotion(sellerId);
    res.json({ success: true, data: toRow(updated, performance.get(updated.id)) });
  } catch (err) {
    next(err);
  }
});

sellerPromotionsRouter.delete('/:id', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const existing = await prisma.promotion.findFirst({
      where: { id: req.params.id, sellerId },
      include: { _count: { select: { redemptions: true } } },
    });
    if (!existing) throw ApiError.notFound('Promotion not found');

    // A promotion that shoppers have used is history — expire it instead of
    // deleting, so past orders keep explaining their discount.
    if (existing._count.redemptions > 0) {
      const updated = await prisma.promotion.update({
        where: { id: existing.id },
        data: { state: 'PAUSED', endAt: new Date() },
      });
      const performance = await performanceByPromotion(sellerId);
      res.json({ success: true, data: toRow(updated, performance.get(updated.id)) });
      return;
    }

    await prisma.promotion.delete({ where: { id: existing.id } });
    res.json({ success: true, data: { id: existing.id, deleted: true } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:id — detail with the redemption trail
// ---------------------------------------------------------------------------

sellerPromotionsRouter.get('/:id', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const promotion = await prisma.promotion.findFirst({
      where: { id: req.params.id, sellerId },
      include: {
        redemptions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            order: { select: { orderNumber: true } },
            user: { select: { name: true } },
          },
        },
      },
    });
    if (!promotion) throw ApiError.notFound('Promotion not found');

    const performance = await performanceByPromotion(sellerId);
    const body: SellerPromotionDetail = {
      ...toRow(promotion, performance.get(promotion.id)),
      redemptions: promotion.redemptions.map((r) => ({
        id: r.id,
        orderNumber: r.order.orderNumber,
        customerName: r.user.name,
        grossPaise: r.grossPaise,
        discountPaise: r.discountPaise,
        createdAt: r.createdAt.toISOString(),
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
