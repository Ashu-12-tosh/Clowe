import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  ADMIN_RETURN_SORTS,
  ADMIN_RETURN_TABS,
  RETURN_REASONS,
  RETURN_REASON_LABELS,
  RETURN_RESOLUTIONS,
  RETURN_RESOLUTION_LABELS,
  RETURN_STAGES,
  RETURN_STAGE_LABELS,
  adminReturnActionSchema,
  adminReturnBulkSchema,
  manualRefundSchema,
  returnPolicySchema,
  type AdminReturnBulkResult,
  type AdminReturnDetail,
  type AdminReturnFilterOptions,
  type AdminReturnListRow,
  type AdminReturnPage,
  type AdminReturnSort,
  type AdminReturnTab,
  type AdminReturnsSummary,
  type ReturnPolicyView,
  type ReturnReasonValue,
  type ReturnResolutionValue,
  type ReturnRiskRow,
  type ReturnStage,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { processRefund } from '../services/refundService';
import { getSettings, setSetting } from '../services/settingsService';
import { creditExpiryFrom } from './credits';

export const adminReturnsRouter = Router();
adminReturnsRouter.use(requireAuth, requireRole('ADMIN'));

const SCAN_CAP = 10000;
/** A refund that has sat PENDING longer than this needs a human. */
const LATE_REFUND_HOURS = 48;
/** Shoppers returning at least this share of what they keep get flagged. */
const HIGH_RETURN_RATE = 50;
const HIGH_RETURN_MIN_ITEMS = 3;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const RETURN_INCLUDE = {
  user: { select: { id: true, name: true, email: true, phone: true } },
  refund: { select: { id: true, status: true, amountPaise: true, processedAt: true } },
  orderItem: {
    include: {
      seller: { select: { id: true, shopName: true } },
      variant: { select: { sku: true } },
      order: {
        select: {
          id: true,
          orderNumber: true,
          totalPaise: true,
          paymentMethod: true,
          createdAt: true,
          payment: { select: { status: true } },
        },
      },
      product: {
        select: {
          id: true,
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
        },
      },
    },
  },
} satisfies Prisma.ReturnInclude;

type ReturnRecord = Prisma.ReturnGetPayload<{ include: typeof RETURN_INCLUDE }>;

/**
 * The stage a return is at. APPROVED splits on whether the courier has picked
 * the parcel up yet — that is the difference between "waiting for pickup" and
 * "on its way back to the warehouse".
 */
function stageOf(r: ReturnRecord): ReturnStage {
  switch (r.status) {
    case 'REQUESTED':
      return 'PENDING_REVIEW';
    case 'APPROVED':
      return r.pickedUpAt ? 'IN_TRANSIT' : 'APPROVED';
    case 'RECEIVED':
      return 'QC';
    case 'REFUNDED':
      return 'REFUNDED';
    default:
      return 'REJECTED';
  }
}

function toRow(r: ReturnRecord): AdminReturnListRow {
  const item = r.orderItem;
  const stage = stageOf(r);
  const resolution = r.resolution as ReturnResolutionValue;
  return {
    id: r.id,
    rmaNumber: r.rmaNumber,
    orderId: item.order.id,
    orderNumber: item.order.orderNumber,
    customer: {
      id: r.user.id,
      name: r.user.name,
      email: r.user.email,
      phone: r.user.phone,
    },
    seller: { id: item.seller.id, name: item.seller.shopName },
    item: {
      productId: item.productId,
      title: item.title,
      imageUrl: item.product.images[0]?.url ?? null,
      size: item.size,
      color: item.color,
      variantLabel: item.variantLabel,
      sku: item.variant.sku,
      quantity: item.quantity,
    },
    reason: r.reasonCategory as ReturnReasonValue,
    reasonLabel: RETURN_REASON_LABELS[r.reasonCategory as ReturnReasonValue] ?? r.reasonCategory,
    reasonDetail: r.reason,
    stage,
    stageLabel: RETURN_STAGE_LABELS[stage],
    status: r.status,
    resolution,
    resolutionLabel: RETURN_RESOLUTION_LABELS[resolution] ?? resolution,
    // Until a refund row exists the amount is what the line is worth.
    refundAmountPaise: r.refund?.amountPaise ?? item.pricePaise * item.quantity,
    refundStatus: r.refund?.status ?? null,
    photos: r.photos,
    // Rejected and never looked at by an admin — the shopper is owed an answer.
    disputed: r.status === 'REJECTED' && r.adminOverrideAt === null,
    ageHours: Math.round((Date.now() - r.createdAt.getTime()) / 3600000),
    requestedAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  tab: z.enum(ADMIN_RETURN_TABS).default('ALL'),
  reason: z.enum(['ALL', ...RETURN_REASONS]).default('ALL'),
  resolution: z.enum(['ALL', ...RETURN_RESOLUTIONS]).default('ALL'),
  sellerId: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  sort: z.enum(ADMIN_RETURN_SORTS).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(10),
});

type ListQuery = z.infer<typeof listQuery>;

const TAB_STAGES: Record<AdminReturnTab, ReturnStage[]> = {
  ALL: [],
  PENDING_REVIEW: ['PENDING_REVIEW'],
  APPROVED: ['APPROVED'],
  IN_TRANSIT: ['IN_TRANSIT'],
  QC: ['QC'],
  REFUNDED: ['REFUNDED'],
  REJECTED: ['REJECTED'],
  DISPUTED: [],
};

function listWhere(query: ListQuery): Prisma.ReturnWhereInput {
  return {
    ...(query.reason === 'ALL' ? {} : { reasonCategory: query.reason }),
    ...(query.resolution === 'ALL' ? {} : { resolution: query.resolution }),
    ...(query.sellerId ? { orderItem: { sellerId: query.sellerId } } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { rmaNumber: { contains: query.q, mode: 'insensitive' } },
            { orderItem: { order: { orderNumber: { contains: query.q, mode: 'insensitive' } } } },
            { orderItem: { title: { contains: query.q, mode: 'insensitive' } } },
            { user: { name: { contains: query.q, mode: 'insensitive' } } },
            { user: { email: { contains: query.q, mode: 'insensitive' } } },
            { user: { phone: { contains: query.q } } },
            { orderItem: { seller: { shopName: { contains: query.q, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };
}

function sortRows(rows: AdminReturnListRow[], sort: AdminReturnSort): AdminReturnListRow[] {
  const ranked = [...rows];
  ranked.sort((a, b) => {
    switch (sort) {
      case 'OLDEST':
        return new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime();
      case 'AMOUNT_HIGH':
        return b.refundAmountPaise - a.refundAmountPaise;
      case 'AMOUNT_LOW':
        return a.refundAmountPaise - b.refundAmountPaise;
      case 'OLDEST_OPEN': {
        // Closed returns sink to the bottom; the rest go oldest-first.
        const openA = ['REFUNDED', 'REJECTED'].includes(a.stage) ? 1 : 0;
        const openB = ['REFUNDED', 'REJECTED'].includes(b.stage) ? 1 : 0;
        if (openA !== openB) return openA - openB;
        return b.ageHours - a.ageHours;
      }
      default:
        return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
    }
  });
  return ranked;
}

adminReturnsRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const records = await prisma.return.findMany({
      where: listWhere(query),
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
      include: RETURN_INCLUDE,
    });
    const all = records.map(toRow);

    const tabCounts = Object.fromEntries(
      ADMIN_RETURN_TABS.map((tab) => [
        tab,
        tab === 'ALL'
          ? all.length
          : tab === 'DISPUTED'
            ? all.filter((r) => r.disputed).length
            : all.filter((r) => TAB_STAGES[tab].includes(r.stage)).length,
      ]),
    ) as Record<AdminReturnTab, number>;

    const filtered =
      query.tab === 'ALL'
        ? all
        : query.tab === 'DISPUTED'
          ? all.filter((r) => r.disputed)
          : all.filter((r) => TAB_STAGES[query.tab].includes(r.stage));
    const sorted = sortRows(filtered, query.sort);
    const start = (query.page - 1) * query.pageSize;

    const body: AdminReturnPage = {
      rows: sorted.slice(start, start + query.pageSize),
      total: sorted.length,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(sorted.length / query.pageSize)),
      tabCounts,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

adminReturnsRouter.get('/summary', async (req, res, next) => {
  try {
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
      .parse(req.query);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const from = new Date(startOfToday.getTime() - (days - 1) * 86400000);
    const previousFrom = new Date(from.getTime() - days * 86400000);

    const [records, previous, deliveredItems, creditLedger, latePendingRefunds] = await Promise.all(
      [
        prisma.return.findMany({
          where: { createdAt: { gte: from } },
          take: SCAN_CAP,
          include: RETURN_INCLUDE,
        }),
        prisma.return.findMany({
          where: { createdAt: { gte: previousFrom, lt: from } },
          select: { id: true, refund: { select: { amountPaise: true, status: true } } },
          take: SCAN_CAP,
        }),
        prisma.orderItem.count({
          where: { status: { in: ['DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] } },
        }),
        // Store-credit settlements are credit-ledger entries, not gateway refunds.
        prisma.creditLedger.aggregate({
          where: { reason: 'REFUND_CREDITS', createdAt: { gte: from } },
          _sum: { delta: true },
        }),
        prisma.refund.count({
          where: {
            status: 'PENDING',
            createdAt: { lt: new Date(Date.now() - LATE_REFUND_HOURS * 3600000) },
          },
        }),
      ],
    );

    const rows = records.map(toRow);
    const change = (value: number, before: number) =>
      before > 0 ? Math.round(((value - before) / before) * 1000) / 10 : null;

    const countByStage = (stage: ReturnStage) => rows.filter((r) => r.stage === stage).length;
    const refundedPaise = records
      .filter((r) => r.refund?.status === 'PROCESSED')
      .reduce((sum, r) => sum + (r.refund?.amountPaise ?? 0), 0);
    const previousRefunded = previous
      .filter((r) => r.refund?.status === 'PROCESSED')
      .reduce((sum, r) => sum + (r.refund?.amountPaise ?? 0), 0);

    // Every return that came back is one delivered item that did not stick.
    const allReturns = await prisma.return.count();
    const returnRatePercent =
      deliveredItems > 0 ? Math.round((allReturns / deliveredItems) * 1000) / 10 : 0;

    const total = rows.length || 1;
    const share = (n: number) => Math.round((n / total) * 1000) / 10;

    // --- Trend -------------------------------------------------------------
    const trend = new Map<string, { returns: number; refundedPaise: number }>();
    for (let i = days - 1; i >= 0; i -= 1) {
      trend.set(dayKey(new Date(startOfToday.getTime() - i * 86400000)), {
        returns: 0,
        refundedPaise: 0,
      });
    }
    for (const r of records) {
      const bucket = trend.get(dayKey(r.createdAt));
      if (!bucket) continue;
      bucket.returns += 1;
      if (r.refund?.status === 'PROCESSED') bucket.refundedPaise += r.refund.amountPaise;
    }

    // --- Per-seller return rate -------------------------------------------
    const sellerReturns = new Map<string, { name: string; returns: number }>();
    for (const r of rows) {
      const entry = sellerReturns.get(r.seller.id) ?? { name: r.seller.name, returns: 0 };
      entry.returns += 1;
      sellerReturns.set(r.seller.id, entry);
    }
    const sellerDelivered = await prisma.orderItem.groupBy({
      by: ['sellerId'],
      where: { status: { in: ['DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] } },
      _count: { _all: true },
    });
    const deliveredBySeller = new Map(sellerDelivered.map((s) => [s.sellerId, s._count._all]));

    // --- Return-risk shoppers ----------------------------------------------
    // No black-box score: a shopper is flagged by rules, and the rules are
    // listed on the row so an admin can see exactly why.
    const [returnsByUser, deliveredByUser] = await Promise.all([
      prisma.return.groupBy({ by: ['userId'], _count: { _all: true } }),
      prisma.orderItem.groupBy({
        by: ['orderId'],
        where: { status: { in: ['DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] } },
        _count: { _all: true },
      }),
    ]);
    const orderOwners = await prisma.order.findMany({
      where: { id: { in: deliveredByUser.map((d) => d.orderId) } },
      select: { id: true, userId: true },
    });
    const ownerByOrder = new Map(orderOwners.map((o) => [o.id, o.userId]));
    const deliveredCountByUser = new Map<string, number>();
    for (const d of deliveredByUser) {
      const userId = ownerByOrder.get(d.orderId);
      if (!userId) continue;
      deliveredCountByUser.set(userId, (deliveredCountByUser.get(userId) ?? 0) + d._count._all);
    }

    const riskUserIds = returnsByUser.map((r) => r.userId);
    const [riskUsers, refundsByUser, damageNoPhoto] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: riskUserIds } },
        select: { id: true, name: true, phone: true },
      }),
      prisma.return.findMany({
        where: { userId: { in: riskUserIds }, refund: { status: 'PROCESSED' } },
        select: { userId: true, refund: { select: { amountPaise: true } } },
      }),
      prisma.return.count({ where: { reasonCategory: 'DAMAGED', photos: { isEmpty: true } } }),
    ]);
    const userById = new Map(riskUsers.map((u) => [u.id, u]));
    const refundedByUser = new Map<string, number>();
    for (const r of refundsByUser) {
      refundedByUser.set(
        r.userId,
        (refundedByUser.get(r.userId) ?? 0) + (r.refund?.amountPaise ?? 0),
      );
    }

    const riskRows: ReturnRiskRow[] = returnsByUser
      .map((r) => {
        const user = userById.get(r.userId);
        const delivered = deliveredCountByUser.get(r.userId) ?? 0;
        const rate = delivered > 0 ? Math.round((r._count._all / delivered) * 1000) / 10 : 0;
        const flags: string[] = [];
        if (delivered >= HIGH_RETURN_MIN_ITEMS && rate >= HIGH_RETURN_RATE) {
          flags.push(`Returns ${rate}% of what they receive`);
        }
        if (r._count._all >= 3) flags.push(`${r._count._all} returns raised`);
        return {
          userId: r.userId,
          name: user?.name ?? null,
          phone: user?.phone ?? '',
          deliveredItems: delivered,
          returns: r._count._all,
          returnRatePercent: rate,
          refundedPaise: refundedByUser.get(r.userId) ?? 0,
          flags,
        };
      })
      .filter((r) => r.flags.length > 0)
      .sort((a, b) => b.returnRatePercent - a.returnRatePercent)
      .slice(0, 8);

    const body: AdminReturnsSummary = {
      kpis: {
        total: rows.length,
        pendingReview: countByStage('PENDING_REVIEW'),
        approved: countByStage('APPROVED'),
        inTransit: countByStage('IN_TRANSIT'),
        qc: countByStage('QC'),
        refunded: countByStage('REFUNDED'),
        rejected: countByStage('REJECTED'),
        refundedPaise,
        // Credits are stored as credit units; the ledger delta is positive when
        // they are granted, and each credit is worth CREDIT_VALUE_PAISE.
        storeCreditPaise: (creditLedger._sum.delta ?? 0) * 50,
        returnRatePercent,
        deliveredItems,
        changePercent: {
          total: change(rows.length, previous.length),
          refundedPaise: change(refundedPaise, previousRefunded),
        },
      },
      stageDistribution: RETURN_STAGES.map((key) => ({
        key,
        label: RETURN_STAGE_LABELS[key],
        count: countByStage(key),
        share: share(countByStage(key)),
      })).filter((s) => s.count > 0),
      reasonBreakdown: RETURN_REASONS.map((key) => {
        const count = rows.filter((r) => r.reason === key).length;
        return { key, label: RETURN_REASON_LABELS[key], count, share: share(count) };
      })
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count),
      resolutionBreakdown: RETURN_RESOLUTIONS.map((key) => {
        const count = rows.filter((r) => r.resolution === key).length;
        return { key, label: RETURN_RESOLUTION_LABELS[key], count, share: share(count) };
      }).filter((r) => r.count > 0),
      // Every return lands in exactly one bucket, so the donut always adds up
      // to the total. Returns settled before QC was tracked get their own
      // bucket rather than quietly going missing from the chart.
      qcBreakdown: (
        [
          ['PASSED', 'QC passed', records.filter((r) => r.qcPassed === true).length],
          ['FAILED', 'QC failed', records.filter((r) => r.qcPassed === false).length],
          [
            'AWAITING',
            'Awaiting QC',
            records.filter((r) => r.status === 'RECEIVED' && r.qcPassed === null).length,
          ],
          [
            'NOT_BACK',
            'Not back yet',
            records.filter((r) => ['REQUESTED', 'APPROVED'].includes(r.status)).length,
          ],
          [
            'NO_QC',
            'Closed without a QC record',
            records.filter(
              (r) => ['REFUNDED', 'REJECTED'].includes(r.status) && r.qcPassed === null,
            ).length,
          ],
        ] as const
      )
        .map(([key, label, count]) => ({ key, label, count, share: share(count) }))
        .filter((q) => q.count > 0),
      trend: [...trend.entries()].map(([date, v]) => ({
        date,
        returns: v.returns,
        refundedPaise: v.refundedPaise,
      })),
      topSellers: [...sellerReturns.entries()]
        .map(([id, s]) => {
          const delivered = deliveredBySeller.get(id) ?? 0;
          return {
            id,
            name: s.name,
            returns: s.returns,
            returnRatePercent: delivered > 0 ? Math.round((s.returns / delivered) * 1000) / 10 : 0,
          };
        })
        .sort((a, b) => b.returns - a.returns)
        .slice(0, 5),
      risk: {
        highRiskCustomers: riskRows.length,
        disputedReturns: rows.filter((r) => r.disputed).length,
        missingPhotoDamageClaims: damageNoPhoto,
        lateRefunds: latePendingRefunds,
        rows: riskRows,
      },
    };

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

adminReturnsRouter.get('/:id', async (req, res, next) => {
  try {
    const r = await prisma.return.findUnique({
      where: { id: req.params.id },
      include: RETURN_INCLUDE,
    });
    if (!r) throw ApiError.notFound('Return not found');

    const [returns, delivered, refunded] = await Promise.all([
      prisma.return.count({ where: { userId: r.userId } }),
      prisma.orderItem.count({
        where: {
          order: { userId: r.userId },
          status: { in: ['DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] },
        },
      }),
      prisma.refund.aggregate({
        where: { order: { userId: r.userId }, status: 'PROCESSED' },
        _sum: { amountPaise: true },
      }),
    ]);

    const body: AdminReturnDetail = {
      ...toRow(r),
      rejectionReason: r.rejectionReason,
      receivedCondition: r.receivedCondition,
      qcPassed: r.qcPassed,
      qcNote: r.qcNote,
      adminOverrideAt: r.adminOverrideAt?.toISOString() ?? null,
      adminOverrideNote: r.adminOverrideNote,
      timeline: [
        {
          key: 'requested',
          label: 'Return requested',
          at: r.createdAt.toISOString(),
          note: r.reason,
        },
        {
          key: 'approved',
          label: 'Approved by seller',
          at: r.approvedAt?.toISOString() ?? null,
          note: null,
        },
        {
          key: 'rejected',
          label: 'Rejected by seller',
          at: r.rejectedAt?.toISOString() ?? null,
          note: r.rejectionReason,
        },
        {
          key: 'picked-up',
          label: 'Collected by courier',
          at: r.pickedUpAt?.toISOString() ?? null,
          note: null,
        },
        {
          key: 'received',
          label: 'Received at warehouse',
          at: r.receivedAt?.toISOString() ?? null,
          note: r.receivedCondition,
        },
        {
          key: 'qc',
          label: r.qcPassed === false ? 'QC failed' : 'QC passed',
          at: r.qcPassed === null ? null : (r.receivedAt?.toISOString() ?? null),
          note: r.qcNote,
        },
        {
          key: 'override',
          label: 'Admin override',
          at: r.adminOverrideAt?.toISOString() ?? null,
          note: r.adminOverrideNote,
        },
        {
          key: 'refunded',
          label: 'Refund processed',
          at: r.refund?.processedAt?.toISOString() ?? null,
          note: null,
        },
      ].filter(
        (step) => step.at !== null || ['requested', 'approved', 'received'].includes(step.key),
      ),
      customerHistory: {
        deliveredItems: delivered,
        returns,
        returnRatePercent: delivered > 0 ? Math.round((returns / delivered) * 1000) / 10 : 0,
        refundedPaise: refunded._sum.amountPaise ?? 0,
      },
      order: {
        totalPaise: r.orderItem.order.totalPaise,
        paymentMethod: r.orderItem.order.paymentMethod,
        paymentStatus: r.orderItem.order.payment?.status ?? null,
        placedAt: r.orderItem.order.createdAt.toISOString(),
        deliveredAt: r.orderItem.deliveredAt?.toISOString() ?? null,
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

interface ActionInput {
  action: string;
  note?: string;
  qcPassed?: boolean;
  resolution?: ReturnResolutionValue;
}

/**
 * Apply one admin action to one return. Every transition is guarded, so an
 * action that does not make sense from the current stage is refused rather
 * than silently skipping a step.
 */
async function applyAdminAction(
  returnId: string,
  input: ActionInput,
  adminId: string,
): Promise<{ rmaNumber: string }> {
  const r = await prisma.return.findUnique({
    where: { id: returnId },
    include: {
      refund: true,
      user: { select: { id: true, phone: true } },
      orderItem: {
        select: {
          id: true,
          title: true,
          pricePaise: true,
          quantity: true,
          orderId: true,
          order: { select: { orderNumber: true } },
        },
      },
    },
  });
  if (!r) throw ApiError.notFound('Return not found');

  const label = `"${r.orderItem.title}" (${r.orderItem.order.orderNumber})`;
  const notify = (type: string, title: string, body: string) =>
    prisma.notification.create({ data: { userId: r.userId, type, title, body } });

  switch (input.action) {
    case 'APPROVE': {
      if (r.status !== 'REQUESTED') {
        throw ApiError.badRequest(
          `${r.rmaNumber} is ${r.status.toLowerCase()}, not awaiting review`,
        );
      }
      await prisma.$transaction([
        prisma.return.update({
          where: { id: r.id },
          data: { status: 'APPROVED', approvedAt: new Date() },
        }),
        notify(
          'RETURN_APPROVED',
          'Return approved ✅',
          `Your return for ${label} is approved. Pickup will be scheduled shortly — please keep the item packed.`,
        ),
      ]);
      break;
    }

    case 'REJECT': {
      if (r.status !== 'REQUESTED') {
        throw ApiError.badRequest(
          `${r.rmaNumber} is ${r.status.toLowerCase()}, not awaiting review`,
        );
      }
      if (!input.note || input.note.length < 3) {
        throw ApiError.badRequest('Give the shopper a reason for the rejection');
      }
      await prisma.$transaction([
        prisma.return.update({
          where: { id: r.id },
          data: {
            status: 'REJECTED',
            rejectionReason: input.note,
            rejectedAt: new Date(),
            resolvedAt: new Date(),
            // An admin rejecting it is itself the review, so it is not disputed.
            adminOverrideAt: new Date(),
            adminOverrideNote: `Rejected by admin: ${input.note}`,
          },
        }),
        prisma.orderItem.update({ where: { id: r.orderItemId }, data: { status: 'DELIVERED' } }),
        notify(
          'RETURN_REJECTED',
          'Return request declined',
          `Your return for ${label} was declined: "${input.note}".`,
        ),
      ]);
      break;
    }

    case 'MARK_PICKED_UP': {
      if (r.status !== 'APPROVED') {
        throw ApiError.badRequest(`${r.rmaNumber} has not been approved yet`);
      }
      if (r.pickedUpAt) throw ApiError.badRequest(`${r.rmaNumber} is already in transit`);
      await prisma.$transaction([
        prisma.return.update({ where: { id: r.id }, data: { pickedUpAt: new Date() } }),
        notify(
          'RETURN_PICKED_UP',
          'Return collected 🚚',
          `We have collected ${label}. Your refund starts once it reaches our warehouse and passes a quick check.`,
        ),
      ]);
      break;
    }

    case 'MARK_RECEIVED': {
      if (r.status !== 'APPROVED') {
        throw ApiError.badRequest(
          `${r.rmaNumber} is ${r.status.toLowerCase()}, not on its way back`,
        );
      }
      if (input.qcPassed === undefined) {
        throw ApiError.badRequest('Record whether the item passed the quality check');
      }
      await prisma.$transaction([
        prisma.return.update({
          where: { id: r.id },
          data: {
            status: 'RECEIVED',
            receivedAt: new Date(),
            receivedCondition: input.qcPassed ? 'OK' : 'DAMAGED',
            qcPassed: input.qcPassed,
            qcNote: input.note ?? null,
            // A failed QC ends the return; nothing is refunded.
            ...(input.qcPassed ? {} : { resolvedAt: new Date() }),
          },
        }),
        notify(
          input.qcPassed ? 'RETURN_RECEIVED' : 'RETURN_QC_FAILED',
          input.qcPassed ? 'Return received 📦' : 'Return did not pass our check',
          input.qcPassed
            ? `We have received ${label} and it passed our check. Your refund is being processed.`
            : `${label} did not pass our quality check${input.note ? `: ${input.note}` : ''}. Our support team will be in touch.`,
        ),
      ]);
      break;
    }

    case 'REFUND': {
      if (r.status !== 'RECEIVED') {
        throw ApiError.badRequest(`${r.rmaNumber} has not been received and checked yet`);
      }
      if (r.qcPassed === false) {
        throw ApiError.badRequest(`${r.rmaNumber} failed QC — it cannot be refunded`, 'QC_FAILED');
      }
      if (r.refund) throw ApiError.badRequest(`${r.rmaNumber} already has a refund`);

      const amountPaise = r.orderItem.pricePaise * r.orderItem.quantity;
      const resolution = input.resolution ?? (r.resolution as ReturnResolutionValue);

      if (resolution === 'STORE_CREDIT') {
        // Credits settle instantly — no gateway, no waiting.
        const credits = Math.floor(amountPaise / 50);
        await prisma.$transaction([
          prisma.return.update({
            where: { id: r.id },
            data: { status: 'REFUNDED', resolution: 'STORE_CREDIT', resolvedAt: new Date() },
          }),
          prisma.user.update({
            where: { id: r.userId },
            data: { creditsBalance: { increment: credits } },
          }),
          prisma.creditLedger.create({
            data: {
              userId: r.userId,
              delta: credits,
              reason: 'REFUND_CREDITS',
              orderId: r.orderItem.orderId,
              expiresAt: creditExpiryFrom(),
            },
          }),
          prisma.orderItem.update({ where: { id: r.orderItemId }, data: { status: 'RETURNED' } }),
          notify(
            'REFUND_PROCESSED',
            'Clowe Credits added 🎁',
            `${credits} Clowe Credits (₹${(amountPaise / 100).toFixed(2)}) added for ${label}. They are ready to use right away.`,
          ),
        ]);
      } else {
        const refund = await prisma.refund.create({
          data: {
            returnId: r.id,
            orderId: r.orderItem.orderId,
            amountPaise,
            provider: 'razorpay',
            status: 'PENDING',
            issuedByAdminId: adminId,
          },
        });
        await prisma.orderItem.update({
          where: { id: r.orderItemId },
          data: { status: 'RETURNED' },
        });
        // processRefund flips the return to REFUNDED and notifies the shopper.
        await processRefund(refund.id);
      }
      break;
    }

    case 'OVERRIDE': {
      if (r.status !== 'REJECTED') {
        throw ApiError.badRequest(`${r.rmaNumber} was not rejected — there is nothing to override`);
      }
      // A previous admin review does not close the door: an admin who rejected
      // by mistake, or one acting on a fresh complaint, has to be able to
      // reopen it. The note records who overturned what.
      if (!input.note || input.note.length < 3) {
        throw ApiError.badRequest('Say why the seller decision is being overturned');
      }
      await prisma.$transaction([
        prisma.return.update({
          where: { id: r.id },
          data: {
            status: 'APPROVED',
            approvedAt: new Date(),
            resolvedAt: null,
            adminOverrideAt: new Date(),
            adminOverrideNote: input.note,
          },
        }),
        prisma.orderItem.update({
          where: { id: r.orderItemId },
          data: { status: 'RETURN_REQUESTED' },
        }),
        notify(
          'RETURN_APPROVED',
          'Return approved on review ✅',
          `We reviewed your return for ${label} and approved it. Pickup will be scheduled shortly.`,
        ),
      ]);
      break;
    }

    default:
      throw ApiError.badRequest('Unknown action');
  }

  return { rmaNumber: r.rmaNumber };
}

adminReturnsRouter.post('/:id/action', async (req, res, next) => {
  try {
    const input = adminReturnActionSchema.parse(req.body);
    const result = await applyAdminAction(req.params.id, input, req.auth!.userId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

adminReturnsRouter.post('/bulk', async (req, res, next) => {
  try {
    const input = adminReturnBulkSchema.parse(req.body);
    const skipped: AdminReturnBulkResult['skipped'] = [];
    let applied = 0;

    for (const id of input.ids) {
      try {
        await applyAdminAction(id, input, req.auth!.userId);
        applied += 1;
      } catch (err) {
        const record = await prisma.return.findUnique({
          where: { id },
          select: { rmaNumber: true },
        });
        skipped.push({
          id,
          rmaNumber: record?.rmaNumber ?? id,
          reason: err instanceof ApiError ? err.message : 'Could not apply that action',
        });
      }
    }

    const body: AdminReturnBulkResult = { applied, skipped };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Goodwill refund — no return behind it
// ---------------------------------------------------------------------------

adminReturnsRouter.post('/manual-refund', async (req, res, next) => {
  try {
    const input = manualRefundSchema.parse(req.body);
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      include: { payment: true, refunds: { where: { status: { not: 'FAILED' } } } },
    });
    if (!order) throw ApiError.notFound('Order not found');

    const alreadyRefunded = order.refunds.reduce((sum, r) => sum + r.amountPaise, 0);
    if (alreadyRefunded + input.amountPaise > order.totalPaise) {
      throw ApiError.badRequest(
        `That would refund ₹${((alreadyRefunded + input.amountPaise) / 100).toFixed(2)} against an order of ₹${(order.totalPaise / 100).toFixed(2)}`,
        'REFUND_EXCEEDS_ORDER',
      );
    }

    if (input.resolution === 'STORE_CREDIT') {
      const credits = Math.floor(input.amountPaise / 50);
      await prisma.$transaction([
        prisma.user.update({
          where: { id: order.userId },
          data: { creditsBalance: { increment: credits } },
        }),
        prisma.creditLedger.create({
          data: {
            userId: order.userId,
            delta: credits,
            reason: 'REFUND_CREDITS',
            orderId: order.id,
            expiresAt: creditExpiryFrom(),
          },
        }),
        prisma.notification.create({
          data: {
            userId: order.userId,
            type: 'REFUND_PROCESSED',
            title: 'Clowe Credits added 🎁',
            body: `${credits} Clowe Credits (₹${(input.amountPaise / 100).toFixed(2)}) added for order ${order.orderNumber}: ${input.reason}`,
          },
        }),
      ]);
      res.json({ success: true, data: { credits, resolution: 'STORE_CREDIT' } });
      return;
    }

    if (!order.payment || order.payment.status !== 'PAID') {
      throw ApiError.badRequest(
        'That order was never paid through the gateway — issue Clowe Credits instead',
        'NOT_PAID',
      );
    }

    const refund = await prisma.refund.create({
      data: {
        orderId: order.id,
        amountPaise: input.amountPaise,
        provider: order.payment.provider,
        status: 'PENDING',
        reason: input.reason,
        issuedByAdminId: req.auth!.userId,
      },
    });
    await processRefund(refund.id);

    const settled = await prisma.refund.findUnique({ where: { id: refund.id } });
    res.json({
      success: true,
      data: { id: refund.id, status: settled?.status, resolution: 'REFUND' },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

adminReturnsRouter.get('/meta/policy', async (_req, res, next) => {
  try {
    const [settings, sellers] = await Promise.all([
      getSettings(),
      prisma.sellerProfile.findMany({
        orderBy: { shopName: 'asc' },
        select: { id: true, shopName: true, returnWindowDays: true },
      }),
    ]);
    const platformWindowDays = settings.returnWindowDays;

    const body: ReturnPolicyView = {
      platformWindowDays,
      sellers: sellers.map((s) => ({
        id: s.id,
        name: s.shopName,
        windowDays: s.returnWindowDays,
        effectiveDays: s.returnWindowDays ?? platformWindowDays,
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

adminReturnsRouter.patch('/meta/policy', async (req, res, next) => {
  try {
    const input = returnPolicySchema.parse(req.body);
    await setSetting('returnWindowDays', input.platformWindowDays);
    res.json({ success: true, data: { platformWindowDays: input.platformWindowDays } });
  } catch (err) {
    next(err);
  }
});

adminReturnsRouter.get('/meta/options', async (_req, res, next) => {
  try {
    const sellers = await prisma.sellerProfile.findMany({
      orderBy: { shopName: 'asc' },
      select: { id: true, shopName: true },
    });
    const body: AdminReturnFilterOptions = {
      sellers: sellers.map((s) => ({ id: s.id, name: s.shopName })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

adminReturnsRouter.get('/meta/export', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const records = await prisma.return.findMany({
      where: listWhere(query),
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
      include: RETURN_INCLUDE,
    });
    const all = records.map(toRow);
    const rows = sortRows(
      query.tab === 'ALL'
        ? all
        : query.tab === 'DISPUTED'
          ? all.filter((r) => r.disputed)
          : all.filter((r) => TAB_STAGES[query.tab].includes(r.stage)),
      query.sort,
    );

    const header = [
      'RMA',
      'Requested',
      'Resolved',
      'Order',
      'Customer',
      'Phone',
      'Seller',
      'Product',
      'SKU',
      'Qty',
      'Reason',
      'Details',
      'Stage',
      'Resolution',
      'Refund amount (₹)',
      'Refund status',
      'Disputed',
    ].join(',');
    const body = rows
      .map((r) =>
        [
          r.rmaNumber,
          r.requestedAt,
          r.resolvedAt ?? '',
          r.orderNumber,
          r.customer.name ?? '',
          r.customer.phone,
          r.seller.name,
          r.item.title,
          r.item.sku,
          r.item.quantity,
          r.reasonLabel,
          r.reasonDetail,
          r.stageLabel,
          r.resolutionLabel,
          (r.refundAmountPaise / 100).toFixed(2),
          r.refundStatus ?? '',
          r.disputed ? 'Yes' : 'No',
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="returns.csv"');
    res.send(`${header}\n${body}`);
  } catch (err) {
    next(err);
  }
});
