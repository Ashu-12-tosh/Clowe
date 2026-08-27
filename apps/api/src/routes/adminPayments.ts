import { Router } from 'express';
import { z } from 'zod';
import {
  RECONCILE_CHECK_LABELS,
  RECONCILE_CHECKS,
  TRANSACTION_SORTS,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TABS,
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_LABELS,
  type AdminPaymentsSummary,
  type GatewayPerformance,
  type PaymentFilterOptions,
  type ReconcileCheck,
  type ReconcileFinding,
  type ReconcileReport,
  type TransactionPage,
  type TransactionRow,
  type TransactionSort,
  type TransactionStatus,
  type TransactionTab,
  type TransactionType,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { getSettings } from '../services/settingsService';

export const adminPaymentsRouter = Router();
adminPaymentsRouter.use(requireAuth, requireRole('ADMIN'));

/** Rows pulled from each source table before filtering happens in memory. */
const SCAN_CAP = 10000;
const STUCK_PAYOUT_HOURS = 24;

// ---------------------------------------------------------------------------
// Status mapping — four vocabularies into one
// ---------------------------------------------------------------------------

function paymentStatusOf(status: string): TransactionStatus {
  if (status === 'PAID') return 'SUCCESS';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'REFUNDED') return 'REFUNDED';
  return 'PENDING';
}

function refundStatusOf(status: string): TransactionStatus {
  if (status === 'PROCESSED') return 'REFUNDED';
  if (status === 'FAILED') return 'FAILED';
  return 'PENDING';
}

function payoutStatusOf(status: string): TransactionStatus {
  if (status === 'PAID') return 'SUCCESS';
  if (status === 'FAILED') return 'FAILED';
  return 'PENDING';
}

function creditStatusOf(status: string): TransactionStatus {
  if (status === 'PAID') return 'SUCCESS';
  if (status === 'FAILED') return 'FAILED';
  return 'PENDING';
}

const TAB_STATUSES: Record<TransactionTab, TransactionStatus[]> = {
  ALL: [],
  SUCCESSFUL: ['SUCCESS'],
  FAILED: ['FAILED'],
  PENDING: ['PENDING'],
  REFUNDED: ['REFUNDED'],
  DISPUTED: [],
};

// ---------------------------------------------------------------------------
// The unified ledger
// ---------------------------------------------------------------------------

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  tab: z.enum(TRANSACTION_TABS).default('ALL'),
  type: z.enum(['ALL', ...TRANSACTION_TYPES]).default('ALL'),
  status: z.enum(['ALL', ...TRANSACTION_STATUSES]).default('ALL'),
  gateway: z.string().trim().optional(),
  sellerId: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  sort: z.enum(TRANSACTION_SORTS).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(10),
});

type ListQuery = z.infer<typeof listQuery>;

function boundsOf(query: { from?: string; to?: string }): { gte?: Date; lte?: Date } | undefined {
  const gte = query.from ? new Date(query.from) : undefined;
  const lte = query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined;
  if (!gte && !lte) return undefined;
  return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
}

/**
 * Everything the ledger shows, in one array. Each source table is loaded
 * separately (they share no schema) and normalised into the same row shape.
 */
async function loadLedger(query: ListQuery): Promise<TransactionRow[]> {
  const createdAt = boundsOf(query);
  const wantsType = (type: TransactionType) => query.type === 'ALL' || query.type === type;

  const [payments, refunds, payouts, creditPurchases, disputedOrderIds] = await Promise.all([
    wantsType('PAYMENT')
      ? prisma.payment.findMany({
          where: { ...(createdAt ? { createdAt } : {}) },
          orderBy: { createdAt: 'desc' },
          take: SCAN_CAP,
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                user: { select: { name: true, email: true, phone: true } },
                items: { select: { seller: { select: { id: true, shopName: true } } } },
              },
            },
          },
        })
      : [],
    wantsType('REFUND')
      ? prisma.refund.findMany({
          where: { ...(createdAt ? { createdAt } : {}) },
          orderBy: { createdAt: 'desc' },
          take: SCAN_CAP,
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                user: { select: { name: true, email: true, phone: true } },
              },
            },
            return: {
              select: {
                orderItem: { select: { seller: { select: { id: true, shopName: true } } } },
              },
            },
          },
        })
      : [],
    wantsType('PAYOUT')
      ? prisma.payout.findMany({
          where: { ...(createdAt ? { requestedAt: createdAt } : {}) },
          orderBy: { requestedAt: 'desc' },
          take: SCAN_CAP,
          include: {
            seller: { select: { id: true, shopName: true, user: { select: { phone: true } } } },
          },
        })
      : [],
    wantsType('CREDIT_PURCHASE')
      ? prisma.creditPurchase.findMany({
          where: { ...(createdAt ? { createdAt } : {}) },
          orderBy: { createdAt: 'desc' },
          take: SCAN_CAP,
          include: { user: { select: { name: true, email: true, phone: true } } },
        })
      : [],
    // A "dispute" here is a real thing the shopper raised: an open support
    // ticket filed against the order under the payment category.
    prisma.complaint
      .findMany({
        where: {
          category: 'PAYMENT',
          status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER'] },
          orderId: { not: null },
        },
        select: { orderId: true },
      })
      .then((rows) => new Set(rows.map((r) => r.orderId!))),
  ]);

  const rows: TransactionRow[] = [];

  for (const p of payments) {
    const status = paymentStatusOf(p.status);
    const sellers = [
      ...new Map(p.order.items.map((i) => [i.seller.id, i.seller.shopName])).values(),
    ];
    rows.push({
      key: `PAYMENT:${p.id}`,
      id: p.id,
      type: 'PAYMENT',
      typeLabel: TRANSACTION_TYPE_LABELS.PAYMENT,
      reference: p.providerPaymentId ?? p.providerOrderId ?? p.id,
      status,
      statusLabel: TRANSACTION_STATUS_LABELS[status],
      sourceStatus: p.status,
      amountPaise: p.amountPaise,
      outgoing: false,
      gateway: p.provider,
      orderId: p.order.id,
      orderNumber: p.order.orderNumber,
      counterpartyName: p.order.user.name,
      counterpartySubtitle: p.order.user.email ?? `+91 ${p.order.user.phone}`,
      sellerName: sellers.join(', ') || null,
      failureReason: p.failureReason,
      disputed: disputedOrderIds.has(p.order.id),
      createdAt: p.createdAt.toISOString(),
    });
  }

  for (const r of refunds) {
    const status = refundStatusOf(r.status);
    rows.push({
      key: `REFUND:${r.id}`,
      id: r.id,
      type: 'REFUND',
      typeLabel: TRANSACTION_TYPE_LABELS.REFUND,
      reference: r.providerRefundId ?? r.id,
      status,
      statusLabel: TRANSACTION_STATUS_LABELS[status],
      sourceStatus: r.status,
      amountPaise: r.amountPaise,
      outgoing: true,
      gateway: r.provider,
      orderId: r.order.id,
      orderNumber: r.order.orderNumber,
      counterpartyName: r.order.user.name,
      counterpartySubtitle: r.order.user.email ?? `+91 ${r.order.user.phone}`,
      sellerName: r.return?.orderItem.seller.shopName ?? null,
      failureReason: r.failureReason,
      disputed: disputedOrderIds.has(r.order.id),
      createdAt: r.createdAt.toISOString(),
    });
  }

  for (const p of payouts) {
    const status = payoutStatusOf(p.status);
    rows.push({
      key: `PAYOUT:${p.id}`,
      id: p.id,
      type: 'PAYOUT',
      typeLabel: TRANSACTION_TYPE_LABELS.PAYOUT,
      reference: p.utr ?? p.reference,
      status,
      statusLabel: TRANSACTION_STATUS_LABELS[status],
      sourceStatus: p.status,
      amountPaise: p.netPaise,
      outgoing: true,
      gateway: p.methodLabel ?? 'bank',
      orderId: null,
      orderNumber: null,
      counterpartyName: p.seller.shopName,
      counterpartySubtitle: `+91 ${p.seller.user.phone}`,
      sellerName: p.seller.shopName,
      failureReason: p.failureReason,
      disputed: false,
      createdAt: p.requestedAt.toISOString(),
    });
  }

  for (const c of creditPurchases) {
    const status = creditStatusOf(c.status);
    rows.push({
      key: `CREDIT_PURCHASE:${c.id}`,
      id: c.id,
      type: 'CREDIT_PURCHASE',
      typeLabel: TRANSACTION_TYPE_LABELS.CREDIT_PURCHASE,
      reference: c.providerPaymentId ?? c.providerOrderId ?? c.id,
      status,
      statusLabel: TRANSACTION_STATUS_LABELS[status],
      sourceStatus: c.status,
      amountPaise: c.amountPaise,
      outgoing: false,
      gateway: c.provider,
      orderId: null,
      orderNumber: null,
      counterpartyName: c.user.name,
      counterpartySubtitle: c.user.email ?? `+91 ${c.user.phone}`,
      sellerName: null,
      failureReason: null,
      disputed: false,
      createdAt: c.createdAt.toISOString(),
    });
  }

  return rows;
}

function applyFilters(
  rows: TransactionRow[],
  query: ListQuery,
  ignoreTab = false,
): TransactionRow[] {
  const needle = query.q?.toLowerCase();
  return rows.filter((row) => {
    if (query.status !== 'ALL' && row.status !== query.status) return false;
    if (query.gateway && row.gateway !== query.gateway) return false;
    if (query.sellerId) {
      // The ledger carries seller names, not ids, so this is resolved by the
      // caller into a name before it gets here.
      if (row.sellerName !== query.sellerId) return false;
    }
    if (!ignoreTab) {
      if (query.tab === 'DISPUTED') {
        if (!row.disputed) return false;
      } else if (TAB_STATUSES[query.tab].length > 0) {
        if (!TAB_STATUSES[query.tab].includes(row.status)) return false;
      }
    }
    if (needle) {
      const haystack = [
        row.reference,
        row.orderNumber,
        row.counterpartyName,
        row.counterpartySubtitle,
        row.sellerName,
        row.id,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

function sortRows(rows: TransactionRow[], sort: TransactionSort): TransactionRow[] {
  const ranked = [...rows];
  ranked.sort((a, b) => {
    switch (sort) {
      case 'OLDEST':
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      case 'AMOUNT_HIGH':
        return b.amountPaise - a.amountPaise;
      case 'AMOUNT_LOW':
        return a.amountPaise - b.amountPaise;
      default:
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
  });
  return ranked;
}

/** The seller filter arrives as an id; the ledger stores shop names. */
async function resolveSellerName(sellerId?: string): Promise<string | undefined> {
  if (!sellerId) return undefined;
  const seller = await prisma.sellerProfile.findUnique({
    where: { id: sellerId },
    select: { shopName: true },
  });
  return seller?.shopName;
}

adminPaymentsRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const sellerName = await resolveSellerName(query.sellerId);
    const resolved = { ...query, sellerId: sellerName };

    const ledger = await loadLedger(query);
    const withoutTab = applyFilters(ledger, resolved, true);

    const tabCounts = Object.fromEntries(
      TRANSACTION_TABS.map((tab) => [
        tab,
        tab === 'ALL'
          ? withoutTab.length
          : tab === 'DISPUTED'
            ? withoutTab.filter((r) => r.disputed).length
            : withoutTab.filter((r) => TAB_STATUSES[tab].includes(r.status)).length,
      ]),
    ) as Record<TransactionTab, number>;

    const filtered = sortRows(applyFilters(ledger, resolved), query.sort);
    const start = (query.page - 1) * query.pageSize;

    const body: TransactionPage = {
      rows: filtered.slice(start, start + query.pageSize),
      total: filtered.length,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(filtered.length / query.pageSize)),
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

adminPaymentsRouter.get('/summary', async (req, res, next) => {
  try {
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
      .parse(req.query);

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const from = new Date(startOfToday.getTime() - (days - 1) * 86400000);
    const previousFrom = new Date(from.getTime() - days * 86400000);
    const settings = await getSettings();

    const [
      payments,
      previousPayments,
      refunds,
      payouts,
      creditPurchases,
      paidOrders,
      previousPaidOrders,
      openPaymentDisputes,
    ] = await Promise.all([
      prisma.payment.findMany({
        where: { createdAt: { gte: from } },
        select: { id: true, status: true, amountPaise: true, provider: true, createdAt: true },
        take: SCAN_CAP,
      }),
      prisma.payment.findMany({
        where: { createdAt: { gte: previousFrom, lt: from } },
        select: { status: true, amountPaise: true },
        take: SCAN_CAP,
      }),
      prisma.refund.findMany({
        where: { createdAt: { gte: from } },
        orderBy: { createdAt: 'desc' },
        take: SCAN_CAP,
        include: { order: { select: { orderNumber: true } } },
      }),
      prisma.payout.findMany({
        where: { requestedAt: { gte: from } },
        select: {
          sellerId: true,
          status: true,
          netPaise: true,
          grossPaise: true,
          commissionPaise: true,
          gatewayPaise: true,
          tdsPaise: true,
        },
        take: SCAN_CAP,
      }),
      prisma.creditPurchase.findMany({
        where: { createdAt: { gte: from } },
        select: { status: true, amountPaise: true, provider: true },
        take: SCAN_CAP,
      }),
      prisma.order.findMany({
        where: { createdAt: { gte: from }, status: { notIn: ['PLACED', 'CANCELLED', 'RETURNED'] } },
        select: { totalPaise: true, createdAt: true },
        take: SCAN_CAP,
      }),
      prisma.order.findMany({
        where: {
          createdAt: { gte: previousFrom, lt: from },
          status: { notIn: ['PLACED', 'CANCELLED', 'RETURNED'] },
        },
        select: { totalPaise: true },
        take: SCAN_CAP,
      }),
      prisma.complaint.count({
        where: {
          category: 'PAYMENT',
          status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER'] },
        },
      }),
    ]);

    const change = (value: number, before: number) =>
      before > 0 ? Math.round(((value - before) / before) * 1000) / 10 : null;

    const successfulPayments = payments.filter((p) => p.status === 'PAID').length;
    const failedPayments = payments.filter((p) => p.status === 'FAILED').length;
    const refundsProcessed = refunds.filter((r) => r.status === 'PROCESSED').length;
    const gmvPaise = paidOrders.reduce((sum, o) => sum + o.totalPaise, 0);
    const previousGmv = previousPaidOrders.reduce((sum, o) => sum + o.totalPaise, 0);
    const totalTransactions =
      payments.length + refunds.length + payouts.length + creditPurchases.length;

    // --- Payment overview (payment rows only) ------------------------------
    const paymentBuckets: { key: string; label: string; match: (s: string) => boolean }[] = [
      { key: 'SUCCESS', label: 'Successful', match: (s) => s === 'PAID' },
      { key: 'FAILED', label: 'Failed', match: (s) => s === 'FAILED' },
      { key: 'REFUNDED', label: 'Refunded', match: (s) => s === 'REFUNDED' },
      { key: 'PENDING', label: 'Pending', match: (s) => s === 'CREATED' },
    ];
    const paymentOverview = paymentBuckets
      .map((b) => {
        const rows = payments.filter((p) => b.match(p.status));
        return {
          key: b.key,
          label: b.label,
          count: rows.length,
          share: payments.length > 0 ? Math.round((rows.length / payments.length) * 1000) / 10 : 0,
          amountPaise: rows.reduce((sum, p) => sum + p.amountPaise, 0),
        };
      })
      .filter((b) => b.count > 0);

    // --- Status distribution across the whole ledger -----------------------
    const statusCounts = new Map<TransactionStatus, number>();
    const bump = (s: TransactionStatus) => statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
    payments.forEach((p) => bump(paymentStatusOf(p.status)));
    refunds.forEach((r) => bump(refundStatusOf(r.status)));
    payouts.forEach((p) => bump(payoutStatusOf(p.status)));
    creditPurchases.forEach((c) => bump(creditStatusOf(c.status)));

    // --- Gateway performance ----------------------------------------------
    const byGateway = new Map<
      string,
      { total: number; ok: number; failed: number; amount: number }
    >();
    for (const p of [...payments, ...creditPurchases]) {
      const entry = byGateway.get(p.provider) ?? { total: 0, ok: 0, failed: 0, amount: 0 };
      entry.total += 1;
      if (p.status === 'PAID') {
        entry.ok += 1;
        entry.amount += p.amountPaise;
      }
      if (p.status === 'FAILED') entry.failed += 1;
      byGateway.set(p.provider, entry);
    }
    const gateways: GatewayPerformance[] = [...byGateway.entries()]
      .map(([gateway, g]) => ({
        gateway,
        transactions: g.total,
        successful: g.ok,
        failed: g.failed,
        // Only settled attempts count for or against the rate — a payment
        // still waiting has not succeeded or failed yet.
        successRate: g.ok + g.failed > 0 ? Math.round((g.ok / (g.ok + g.failed)) * 1000) / 10 : 100,
        amountPaise: g.amount,
      }))
      .sort((a, b) => b.transactions - a.transactions);

    // --- Risk alerts (each one computed, none decorative) ------------------
    const [failureProne, refundHeavy, stuckPayouts] = await Promise.all([
      prisma.payment
        .groupBy({
          by: ['orderId'],
          where: { status: 'FAILED', createdAt: { gte: from } },
          _count: { _all: true },
        })
        .then((rows) => rows.length),
      prisma.refund
        .groupBy({ by: ['orderId'], where: { createdAt: { gte: from } }, _count: { _all: true } })
        .then((rows) => rows.length),
      prisma.payout.count({
        where: {
          status: 'PROCESSING',
          requestedAt: { lt: new Date(Date.now() - STUCK_PAYOUT_HOURS * 3600000) },
        },
      }),
    ]);

    // --- GMV trend ---------------------------------------------------------
    const trend = new Map<string, { gmvPaise: number; transactions: number }>();
    for (let i = days - 1; i >= 0; i -= 1) {
      trend.set(dayKey(new Date(startOfToday.getTime() - i * 86400000)), {
        gmvPaise: 0,
        transactions: 0,
      });
    }
    for (const o of paidOrders) {
      const bucket = trend.get(dayKey(o.createdAt));
      if (bucket) bucket.gmvPaise += o.totalPaise;
    }
    for (const p of payments) {
      const bucket = trend.get(dayKey(p.createdAt));
      if (bucket) bucket.transactions += 1;
    }

    // --- Payouts -----------------------------------------------------------
    const payoutStatusKeys = ['PENDING', 'PROCESSING', 'PAID', 'FAILED'] as const;
    const payoutLabels: Record<string, string> = {
      PENDING: 'Awaiting processing',
      PROCESSING: 'In process',
      PAID: 'Settled',
      FAILED: 'Failed',
    };
    const paidPayouts = payouts.filter((p) => p.status === 'PAID');
    const pendingPayouts = payouts.filter((p) => ['PENDING', 'PROCESSING'].includes(p.status));

    // --- Financial summary -------------------------------------------------
    // Commission and gateway fees are what the marketplace charges sellers.
    // Payout rows carry the real figures once raised; before that, the settings
    // rates applied to GMV are the best available estimate, so anything not yet
    // covered by a payout is priced with those same rates.
    const payoutCommission = payouts.reduce((sum, p) => sum + p.commissionPaise, 0);
    const payoutGateway = payouts.reduce((sum, p) => sum + p.gatewayPaise, 0);
    const payoutGross = payouts.reduce((sum, p) => sum + p.grossPaise, 0);
    const uncoveredGmv = Math.max(0, gmvPaise - payoutGross);
    const commissionPaise =
      payoutCommission + Math.round((uncoveredGmv * settings.payoutCommissionPercent) / 100);
    const gatewayFeePaise =
      payoutGateway + Math.round((uncoveredGmv * settings.payoutGatewayPercent) / 100);
    const refundsPaise = refunds
      .filter((r) => r.status === 'PROCESSED')
      .reduce((sum, r) => sum + r.amountPaise, 0);

    const totalLedger = totalTransactions || 1;
    const body: AdminPaymentsSummary = {
      range: { from: from.toISOString(), to: now.toISOString(), days },
      kpis: {
        totalTransactions,
        successfulPayments,
        failedPayments,
        refundsProcessed,
        gmvPaise,
        netPayoutsPaise: paidPayouts.reduce((sum, p) => sum + p.netPaise, 0),
        changePercent: {
          totalTransactions: change(payments.length, previousPayments.length),
          successfulPayments: change(
            successfulPayments,
            previousPayments.filter((p) => p.status === 'PAID').length,
          ),
          failedPayments: change(
            failedPayments,
            previousPayments.filter((p) => p.status === 'FAILED').length,
          ),
          gmvPaise: change(gmvPaise, previousGmv),
        },
      },
      paymentOverview,
      statusDistribution: TRANSACTION_STATUSES.map((key) => {
        const count = statusCounts.get(key) ?? 0;
        return {
          key,
          label: TRANSACTION_STATUS_LABELS[key],
          count,
          share: Math.round((count / totalLedger) * 1000) / 10,
        };
      }).filter((s) => s.count > 0),
      gateways,
      riskAlerts: [
        {
          key: 'failed-payments',
          label: 'Orders with a failed payment',
          count: failureProne,
          detail: 'Checkout started but the money never landed',
        },
        {
          key: 'payment-disputes',
          label: 'Open payment disputes',
          count: openPaymentDisputes,
          detail: 'Support tickets filed under the payment category',
        },
        {
          key: 'refunded-orders',
          label: 'Orders refunded in this period',
          count: refundHeavy,
          detail: 'Money returned to shoppers',
        },
        {
          key: 'stuck-payouts',
          label: 'Payouts stuck in processing',
          count: stuckPayouts,
          detail: `Handed to the bank over ${STUCK_PAYOUT_HOURS}h ago and still not settled`,
        },
      ],
      recentRefunds: refunds.slice(0, 5).map((r) => ({
        id: r.id,
        reference: r.providerRefundId ?? r.id,
        orderNumber: r.order.orderNumber,
        amountPaise: r.amountPaise,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
      gmvTrend: [...trend.entries()].map(([date, v]) => ({
        date,
        gmvPaise: v.gmvPaise,
        transactions: v.transactions,
      })),
      payouts: {
        paidPaise: paidPayouts.reduce((sum, p) => sum + p.netPaise, 0),
        pendingPaise: pendingPayouts.reduce((sum, p) => sum + p.netPaise, 0),
        sellersPaid: new Set(paidPayouts.map((p) => p.sellerId)).size,
        byStatus: payoutStatusKeys
          .map((key) => {
            const count = payouts.filter((p) => p.status === key).length;
            return {
              key,
              label: payoutLabels[key]!,
              count,
              share: payouts.length > 0 ? Math.round((count / payouts.length) * 1000) / 10 : 0,
            };
          })
          .filter((s) => s.count > 0),
      },
      financials: {
        gmvPaise,
        commissionPaise,
        gatewayFeePaise,
        tdsPaise: payouts.reduce((sum, p) => sum + p.tdsPaise, 0),
        refundsPaise,
        netRevenuePaise: commissionPaise + gatewayFeePaise - refundsPaise,
      },
    };

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Reconciliation — does the money agree with the orders?
// ---------------------------------------------------------------------------

adminPaymentsRouter.post('/reconcile', async (_req, res, next) => {
  try {
    const findings: ReconcileFinding[] = [];

    const [payments, refunds, payouts, orders] = await Promise.all([
      prisma.payment.findMany({
        take: SCAN_CAP,
        include: { order: { select: { orderNumber: true, totalPaise: true, status: true } } },
      }),
      prisma.refund.findMany({
        take: SCAN_CAP,
        include: { order: { select: { orderNumber: true, totalPaise: true } } },
      }),
      prisma.payout.findMany({
        take: SCAN_CAP,
        include: { seller: { select: { shopName: true } } },
      }),
      prisma.order.findMany({
        where: { status: { not: 'PLACED' } },
        take: SCAN_CAP,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          totalPaise: true,
          paymentMethod: true,
          payment: { select: { status: true } },
          items: { select: { status: true } },
        },
      }),
    ]);

    // 1. A payment must be for exactly what the order asked for.
    for (const p of payments) {
      if (p.amountPaise !== p.order.totalPaise) {
        findings.push({
          check: 'PAYMENT_AMOUNT_MISMATCH',
          label: RECONCILE_CHECK_LABELS.PAYMENT_AMOUNT_MISMATCH,
          reference: p.providerPaymentId ?? p.id,
          orderNumber: p.order.orderNumber,
          detail: `Payment ₹${(p.amountPaise / 100).toFixed(2)} vs order ₹${(p.order.totalPaise / 100).toFixed(2)}`,
          differencePaise: p.amountPaise - p.order.totalPaise,
        });
      }
      // 2. A successful payment on an order that was cancelled with no refund
      //    is money the platform is holding that it should not be.
      if (p.status === 'PAID' && p.order.status === 'CANCELLED') {
        const refunded = refunds
          .filter((r) => r.orderId === p.orderId && r.status === 'PROCESSED')
          .reduce((sum, r) => sum + r.amountPaise, 0);
        if (refunded < p.amountPaise) {
          findings.push({
            check: 'ORPHAN_SUCCESSFUL_PAYMENT',
            label: RECONCILE_CHECK_LABELS.ORPHAN_SUCCESSFUL_PAYMENT,
            reference: p.providerPaymentId ?? p.id,
            orderNumber: p.order.orderNumber,
            detail: `₹${((p.amountPaise - refunded) / 100).toFixed(2)} collected on a cancelled order and not refunded`,
            differencePaise: p.amountPaise - refunded,
          });
        }
      }
    }

    // 3. Refunds can never exceed what came in.
    const refundsByOrder = new Map<string, number>();
    for (const r of refunds) {
      if (r.status !== 'PROCESSED') continue;
      refundsByOrder.set(r.orderId, (refundsByOrder.get(r.orderId) ?? 0) + r.amountPaise);
    }
    for (const [orderId, refunded] of refundsByOrder) {
      const order = refunds.find((r) => r.orderId === orderId)!.order;
      if (refunded > order.totalPaise) {
        findings.push({
          check: 'REFUND_EXCEEDS_ORDER',
          label: RECONCILE_CHECK_LABELS.REFUND_EXCEEDS_ORDER,
          reference: orderId,
          orderNumber: order.orderNumber,
          detail: `Refunded ₹${(refunded / 100).toFixed(2)} against an order of ₹${(order.totalPaise / 100).toFixed(2)}`,
          differencePaise: refunded - order.totalPaise,
        });
      }
    }

    // 4/5. Order-side checks.
    for (const o of orders) {
      if (!o.payment && o.status !== 'CANCELLED') {
        findings.push({
          check: 'PAID_ORDER_WITHOUT_PAYMENT',
          label: RECONCILE_CHECK_LABELS.PAID_ORDER_WITHOUT_PAYMENT,
          reference: o.id,
          orderNumber: o.orderNumber,
          detail: `Order is ${o.status.toLowerCase()} with no payment row`,
          differencePaise: o.totalPaise,
        });
      }
      const live = o.items.filter((i) => i.status !== 'CANCELLED');
      const allDelivered = live.length > 0 && live.every((i) => i.status === 'DELIVERED');
      if (o.paymentMethod === 'COD' && allDelivered && o.payment?.status === 'CREATED') {
        findings.push({
          check: 'DELIVERED_COD_UNSETTLED',
          label: RECONCILE_CHECK_LABELS.DELIVERED_COD_UNSETTLED,
          reference: o.id,
          orderNumber: o.orderNumber,
          detail: `₹${(o.totalPaise / 100).toFixed(2)} collected at the door but still marked pending`,
          differencePaise: o.totalPaise,
        });
      }
    }

    // 6/7. Payout-side checks.
    const stuckBefore = new Date(Date.now() - STUCK_PAYOUT_HOURS * 3600000);
    for (const p of payouts) {
      const expected =
        p.grossPaise -
        p.commissionPaise -
        p.gatewayPaise -
        p.otherFeesPaise -
        p.tdsPaise +
        p.adjustmentPaise;
      if (expected !== p.netPaise) {
        findings.push({
          check: 'PAYOUT_MATH_MISMATCH',
          label: RECONCILE_CHECK_LABELS.PAYOUT_MATH_MISMATCH,
          reference: p.reference,
          orderNumber: null,
          detail: `${p.seller.shopName}: net ₹${(p.netPaise / 100).toFixed(2)}, expected ₹${(expected / 100).toFixed(2)}`,
          differencePaise: p.netPaise - expected,
        });
      }
      if (p.status === 'PROCESSING' && p.requestedAt < stuckBefore) {
        findings.push({
          check: 'STUCK_PROCESSING_PAYOUT',
          label: RECONCILE_CHECK_LABELS.STUCK_PROCESSING_PAYOUT,
          reference: p.reference,
          orderNumber: null,
          detail: `${p.seller.shopName}: requested ${p.requestedAt.toISOString().slice(0, 10)}, still processing`,
          differencePaise: p.netPaise,
        });
      }
    }

    const body: ReconcileReport = {
      ranAt: new Date().toISOString(),
      checked: {
        payments: payments.length,
        refunds: refunds.length,
        payouts: payouts.length,
        orders: orders.length,
      },
      findings: findings.slice(0, 200),
      byCheck: RECONCILE_CHECKS.map((check) => ({
        check: check as ReconcileCheck,
        label: RECONCILE_CHECK_LABELS[check],
        count: findings.filter((f) => f.check === check).length,
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Meta + exports
// ---------------------------------------------------------------------------

adminPaymentsRouter.get('/meta/options', async (_req, res, next) => {
  try {
    const [paymentProviders, refundProviders, creditProviders, sellers] = await Promise.all([
      prisma.payment.findMany({ distinct: ['provider'], select: { provider: true } }),
      prisma.refund.findMany({ distinct: ['provider'], select: { provider: true } }),
      prisma.creditPurchase.findMany({ distinct: ['provider'], select: { provider: true } }),
      prisma.sellerProfile.findMany({
        orderBy: { shopName: 'asc' },
        select: { id: true, shopName: true },
      }),
    ]);
    const body: PaymentFilterOptions = {
      gateways: [
        ...new Set(
          [...paymentProviders, ...refundProviders, ...creditProviders].map((p) => p.provider),
        ),
      ].sort(),
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

adminPaymentsRouter.get('/export', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const sellerName = await resolveSellerName(query.sellerId);
    const rows = sortRows(
      applyFilters(await loadLedger(query), { ...query, sellerId: sellerName }),
      query.sort,
    );

    const header = [
      'Date',
      'Type',
      'Reference',
      'Order',
      'Counterparty',
      'Seller',
      'Gateway',
      'Direction',
      'Amount (₹)',
      'Status',
      'Failure reason',
    ].join(',');
    const body = rows
      .map((r) =>
        [
          r.createdAt,
          r.typeLabel,
          r.reference,
          r.orderNumber ?? '',
          r.counterpartyName ?? '',
          r.sellerName ?? '',
          r.gateway,
          r.outgoing ? 'Out' : 'In',
          (r.amountPaise / 100).toFixed(2),
          r.statusLabel,
          r.failureReason ?? '',
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    res.send(`${header}\n${body}`);
  } catch (err) {
    next(err);
  }
});

/** Seller settlements: what each payout was made of, line by line. */
adminPaymentsRouter.get('/settlement/export', async (req, res, next) => {
  try {
    const { from, to } = z
      .object({ from: z.string().trim().optional(), to: z.string().trim().optional() })
      .parse(req.query);
    const requestedAt = boundsOf({ from, to });

    const payouts = await prisma.payout.findMany({
      where: { ...(requestedAt ? { requestedAt } : {}) },
      orderBy: { requestedAt: 'desc' },
      take: SCAN_CAP,
      include: {
        seller: { select: { shopName: true, user: { select: { phone: true } } } },
        _count: { select: { items: true } },
      },
    });

    const header = [
      'Payout',
      'Requested',
      'Processed',
      'Seller',
      'Seller phone',
      'Period from',
      'Period to',
      'Order lines',
      'Gross (₹)',
      'Commission (₹)',
      'Gateway fee (₹)',
      'Other fees (₹)',
      'Adjustments (₹)',
      'TDS (₹)',
      'Net paid (₹)',
      'Method',
      'UTR',
      'Status',
    ].join(',');
    const body = payouts
      .map((p) =>
        [
          p.reference,
          p.requestedAt.toISOString(),
          p.processedAt?.toISOString() ?? '',
          p.seller.shopName,
          p.seller.user.phone,
          p.periodFrom.toISOString().slice(0, 10),
          p.periodTo.toISOString().slice(0, 10),
          p._count.items,
          (p.grossPaise / 100).toFixed(2),
          (p.commissionPaise / 100).toFixed(2),
          (p.gatewayPaise / 100).toFixed(2),
          (p.otherFeesPaise / 100).toFixed(2),
          (p.adjustmentPaise / 100).toFixed(2),
          (p.tdsPaise / 100).toFixed(2),
          (p.netPaise / 100).toFixed(2),
          p.methodLabel ?? '',
          p.utr ?? '',
          p.status,
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="settlement-report.csv"');
    res.send(`${header}\n${body}`);
  } catch (err) {
    next(err);
  }
});
