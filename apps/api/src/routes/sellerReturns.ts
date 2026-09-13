import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  RETURN_REASON_LABELS,
  RETURN_STATUS_LABELS,
  RETURN_TABS,
  SELLER_RETURN_SORTS,
  type ReturnReasonValue,
  type ReturnTab,
  type SellerReturnListRow,
  type SellerReturnPage,
  type SellerReturnSort,
  type SellerReturnSummary,
  type SellerReturnActionInput,
} from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { applyReturnDecision } from '../services/returnService';
import { requireSeller } from './seller';

export const sellerReturnsRouter = Router();
sellerReturnsRouter.use(requireAuth, requireSeller);

/** A seller's return volume is small enough to rank in memory. */
const SCAN_CAP = 2000;
/** A request with no decision after this long is flagged as overdue. */
const DECISION_SLA_HOURS = 48;

const listQuery = z.object({
  tab: z.enum(RETURN_TABS).default('ALL'),
  q: z.string().trim().max(80).optional(),
  reason: z.string().trim().optional(),
  sort: z.enum(SELLER_RETURN_SORTS).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
});

const RETURN_INCLUDE = {
  refund: true,
  user: { select: { name: true, email: true } },
  orderItem: {
    include: {
      order: { select: { id: true, orderNumber: true, createdAt: true, paymentMethod: true } },
      product: { select: { id: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
    },
  },
} satisfies Prisma.ReturnInclude;

type ReturnRecord = Prisma.ReturnGetPayload<{ include: typeof RETURN_INCLUDE }>;

/** RTN-YYYYMMDD-XXXX — stable, readable, derived from the row itself. */
function reference(id: string, createdAt: Date): string {
  const y = createdAt.getFullYear();
  const m = String(createdAt.getMonth() + 1).padStart(2, '0');
  const d = String(createdAt.getDate()).padStart(2, '0');
  return `RTN-${y}${m}${d}-${id.slice(-4).toUpperCase()}`;
}

function toRow(record: ReturnRecord): SellerReturnListRow {
  const item = record.orderItem;
  const refundAmountPaise = item.pricePaise * item.quantity;
  const isCod = item.order.paymentMethod === 'COD';
  return {
    id: record.id,
    reference: reference(record.id, record.createdAt),
    orderItemId: record.orderItemId,
    orderId: item.order.id,
    orderNumber: item.order.orderNumber,
    orderedAt: item.order.createdAt.toISOString(),
    customerName: record.user.name ?? 'Customer',
    customerEmail: record.user.email,
    title: item.title,
    size: item.size,
    color: item.color,
    variantLabel: item.variantLabel,
    quantity: item.quantity,
    imageUrl: item.product.images[0]?.url ?? null,
    reason: record.reasonCategory as ReturnReasonValue,
    reasonLabel: RETURN_REASON_LABELS[record.reasonCategory as ReturnReasonValue],
    details: record.reason,
    photos: record.photos,
    status: record.status,
    statusLabel: RETURN_STATUS_LABELS[record.status] ?? record.status,
    rejectionReason: record.rejectionReason,
    receivedCondition: record.receivedCondition,
    adminOverrideAt: record.adminOverrideAt?.toISOString() ?? null,
    refundAmountPaise: record.status === 'REJECTED' ? 0 : refundAmountPaise,
    refund: record.refund
      ? {
          status: record.refund.status,
          amountPaise: record.refund.amountPaise,
          providerRefundId: record.refund.providerRefundId,
        }
      : null,
    refundRoute: isCod ? 'Refund to wallet / bank' : 'Refund to original payment',
    requestedAt: record.createdAt.toISOString(),
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
    canApprove: record.status === 'REQUESTED',
    canReject: record.status === 'REQUESTED',
    canMarkReceived: record.status === 'APPROVED',
  };
}

/** The tabs group the five DB statuses the way a seller works through them. */
function matchesTab(row: SellerReturnListRow, tab: ReturnTab): boolean {
  switch (tab) {
    case 'REQUESTED':
      return row.status === 'REQUESTED';
    case 'APPROVED':
      return row.status === 'APPROVED';
    case 'RECEIVED':
      return row.status === 'RECEIVED';
    case 'REFUNDED':
      return row.status === 'REFUNDED';
    case 'REJECTED':
      return row.status === 'REJECTED';
    default:
      return true;
  }
}

function compare(a: SellerReturnListRow, b: SellerReturnListRow, sort: SellerReturnSort): number {
  switch (sort) {
    case 'OLDEST':
      return a.requestedAt.localeCompare(b.requestedAt);
    case 'AMOUNT_HIGH':
      return b.refundAmountPaise - a.refundAmountPaise;
    case 'AMOUNT_LOW':
      return a.refundAmountPaise - b.refundAmountPaise;
    default:
      return b.requestedAt.localeCompare(a.requestedAt);
  }
}

async function loadRows(
  sellerId: string,
  query: z.infer<typeof listQuery>,
): Promise<SellerReturnListRow[]> {
  const where: Prisma.ReturnWhereInput = {
    orderItem: { sellerId },
    ...(query.reason ? { reasonCategory: query.reason as ReturnRecord['reasonCategory'] } : {}),
    ...(query.q
      ? {
          OR: [
            { orderItem: { sellerId, title: { contains: query.q, mode: 'insensitive' } } },
            {
              orderItem: {
                sellerId,
                order: { orderNumber: { contains: query.q, mode: 'insensitive' } },
              },
            },
            { user: { name: { contains: query.q, mode: 'insensitive' } } },
            { id: { endsWith: query.q.toLowerCase().replace(/^rtn-\d{8}-/i, '') } },
          ],
        }
      : {}),
  };

  const records = await prisma.return.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: SCAN_CAP,
    include: RETURN_INCLUDE,
  });
  return records
    .map(toRow)
    .filter((row) => matchesTab(row, query.tab))
    .sort((a, b) => compare(a, b, query.sort));
}

// ---------------------------------------------------------------------------
// GET / — the returns table
// ---------------------------------------------------------------------------

sellerReturnsRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const rows = await loadRows(req.seller!.id, query);
    const body: SellerReturnPage = {
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
// GET /summary — KPIs, status split, reasons, policy
// ---------------------------------------------------------------------------

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

sellerReturnsRouter.get('/summary', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [rows, deliveredUnits, prevDeliveredUnits] = await Promise.all([
      loadRows(sellerId, listQuery.parse({})),
      prisma.orderItem.aggregate({
        _sum: { quantity: true },
        where: {
          sellerId,
          status: { in: ['DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] },
          deliveredAt: { gte: monthStart },
        },
      }),
      prisma.orderItem.aggregate({
        _sum: { quantity: true },
        where: {
          sellerId,
          status: { in: ['DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] },
          deliveredAt: { gte: prevMonthStart, lt: monthStart },
        },
      }),
    ]);

    const inMonth = (row: SellerReturnListRow, from: Date, to?: Date) => {
      const at = new Date(row.requestedAt);
      return at >= from && (!to || at < to);
    };
    const thisMonth = rows.filter((r) => inMonth(r, monthStart));
    const lastMonth = rows.filter((r) => inMonth(r, prevMonthStart, monthStart));

    const unitsThisMonth = deliveredUnits._sum.quantity ?? 0;
    const unitsLastMonth = prevDeliveredUnits._sum.quantity ?? 0;
    const rate = (returns: number, units: number) =>
      units > 0 ? Math.round((returns / units) * 1000) / 10 : 0;
    const returnRate = rate(
      thisMonth.reduce((sum, r) => sum + r.quantity, 0),
      unitsThisMonth,
    );
    const prevReturnRate = rate(
      lastMonth.reduce((sum, r) => sum + r.quantity, 0),
      unitsLastMonth,
    );

    const statusCounts = new Map<string, number>();
    for (const row of rows) statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);

    const reasonCounts = new Map<ReturnReasonValue, number>();
    for (const row of rows) reasonCounts.set(row.reason, (reasonCounts.get(row.reason) ?? 0) + 1);

    const productCounts = new Map<string, { title: string; count: number; valuePaise: number }>();
    for (const row of rows) {
      const entry = productCounts.get(row.title) ?? {
        title: row.title,
        count: 0,
        valuePaise: 0,
      };
      entry.count += 1;
      entry.valuePaise += row.refundAmountPaise;
      productCounts.set(row.title, entry);
    }

    const slaCutoff = new Date(now.getTime() - DECISION_SLA_HOURS * 3600000);
    const refunded = rows.filter((r) => r.status === 'REFUNDED');

    const body: SellerReturnSummary = {
      kpis: {
        requests: rows.length,
        requestsChangePercent: changePercent(thisMonth.length, lastMonth.length),
        approved: statusCounts.get('APPROVED') ?? 0,
        inTransit: statusCounts.get('RECEIVED') ?? 0,
        refunded: refunded.length,
        refundedValuePaise: refunded.reduce((sum, r) => sum + r.refundAmountPaise, 0),
        rejected: statusCounts.get('REJECTED') ?? 0,
        returnRate,
        returnRateChange:
          prevReturnRate > 0 ? Math.round((returnRate - prevReturnRate) * 10) / 10 : null,
      },
      statusBreakdown: [...statusCounts.entries()]
        .map(([key, count]) => ({
          key,
          label: RETURN_STATUS_LABELS[key] ?? key,
          count,
          share: rows.length > 0 ? Math.round((count / rows.length) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count),
      topReasons: [...reasonCounts.entries()]
        .map(([key, count]) => ({
          key,
          label: RETURN_REASON_LABELS[key],
          count,
          share: rows.length > 0 ? Math.round((count / rows.length) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count),
      topProducts: [...productCounts.entries()]
        .map(([title, v]) => ({ productId: title, title: v.title, count: v.count, valuePaise: v.valuePaise }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      policy: {
        returnWindowDays: env.RETURN_WINDOW_DAYS,
        refundBusinessDays: '3–5 business days',
        returnShipping: 'Free pickup — return shipping is on the marketplace',
        decisionSlaHours: DECISION_SLA_HOURS,
        overdueCount: rows.filter(
          (r) => r.status === 'REQUESTED' && new Date(r.requestedAt) < slaCutoff,
        ).length,
      },
      counts: Object.fromEntries(
        RETURN_TABS.map((tab) => [tab, rows.filter((r) => matchesTab(r, tab)).length]),
      ) as Record<ReturnTab, number>,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /export — the filtered list as CSV
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

sellerReturnsRouter.get('/export', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const rows = await loadRows(req.seller!.id, query);

    const header = [
      'Return ID',
      'Order',
      'Requested on',
      'Customer',
      'Product',
      'Size',
      'Colour',
      'Qty',
      'Reason',
      'Details',
      'Status',
      'Refund (INR)',
      'Refund status',
      'Resolved on',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.reference,
          row.orderNumber,
          row.requestedAt,
          row.customerName,
          row.title,
          row.size,
          row.color,
          row.quantity,
          row.reasonLabel,
          row.details ?? '',
          row.status,
          (row.refundAmountPaise / 100).toFixed(2),
          row.refund?.status ?? '',
          row.resolvedAt ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clowe-returns.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /bulk — one decision across many returns
// ---------------------------------------------------------------------------

const bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'Select at least one return').max(100),
  action: z.enum(['approve', 'reject', 'received']),
  /** Required by 'reject'. */
  rejectionReason: z.string().trim().min(5).max(300).optional(),
  /** Required by 'received'. */
  condition: z.enum(['OK', 'DAMAGED']).optional(),
});

sellerReturnsRouter.post('/bulk', async (req, res, next) => {
  try {
    const input = bulkSchema.parse(req.body);
    if (input.action === 'reject' && !input.rejectionReason) {
      throw ApiError.badRequest('Give the customer a reason for rejecting', 'REASON_REQUIRED');
    }

    const decision: SellerReturnActionInput =
      input.action === 'approve'
        ? { action: 'approve' }
        : input.action === 'reject'
          ? { action: 'reject', rejectionReason: input.rejectionReason! }
          : { action: 'received', condition: input.condition ?? 'OK' };

    let updated = 0;
    const skipped: { id: string; reason: string }[] = [];
    for (const id of input.ids) {
      try {
        await applyReturnDecision(req.seller!.id, id, decision);
        updated += 1;
      } catch (err) {
        skipped.push({
          id,
          reason: err instanceof ApiError ? err.message : 'Could not update this return',
        });
      }
    }
    res.json({ success: true, data: { updated, skipped } });
  } catch (err) {
    next(err);
  }
});
