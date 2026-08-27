import { Router } from 'express';
import { z } from 'zod';
import {
  SELLER_DASH_RANGES,
  SELLER_DASH_RANGE_LABELS,
  type HealthGrade,
  type HealthMetric,
  type SellerDashRange,
  type SellerDashboard,
  type SellerMetric,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { getSettings } from '../services/settingsService';
import { availableBalance, feesFor } from '../services/payoutService';
import { requireSeller } from './seller';

export const sellerDashboardRouter = Router();
sellerDashboardRouter.use(requireAuth, requireSeller);

const ITEM_CAP = 20000;

const ORDER_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: 'Processing',
  PACKED: 'Processing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURN_REQUESTED: 'Return requested',
  RETURNED: 'Returned',
};

/** The buckets the donut shows, in the order they are drawn. */
const STATUS_BUCKETS: { key: string; label: string; statuses: string[] }[] = [
  { key: 'DELIVERED', label: 'Delivered', statuses: ['DELIVERED'] },
  { key: 'PROCESSING', label: 'Processing', statuses: ['CONFIRMED', 'PACKED'] },
  { key: 'SHIPPED', label: 'Shipped', statuses: ['SHIPPED'] },
  { key: 'CANCELLED', label: 'Cancelled', statuses: ['CANCELLED'] },
  { key: 'RETURNED', label: 'Returned', statuses: ['RETURN_REQUESTED', 'RETURNED'] },
];

// ---------------------------------------------------------------------------
// Store health
//
// The bands below are the grading scale, kept next to the metric so the UI can
// show a seller exactly why they scored what they did.
// ---------------------------------------------------------------------------

const HEALTH_BANDS = {
  /** Order defect rate — the industry-standard "something went wrong" measure. */
  defect: [
    { grade: 'EXCELLENT' as HealthGrade, upTo: 1 },
    { grade: 'GOOD' as HealthGrade, upTo: 2 },
    { grade: 'FAIR' as HealthGrade, upTo: 5 },
    { grade: 'POOR' as HealthGrade, upTo: 100 },
  ],
  cancellation: [
    { grade: 'EXCELLENT' as HealthGrade, upTo: 1 },
    { grade: 'GOOD' as HealthGrade, upTo: 2.5 },
    { grade: 'FAIR' as HealthGrade, upTo: 5 },
    { grade: 'POOR' as HealthGrade, upTo: 100 },
  ],
  returns: [
    { grade: 'EXCELLENT' as HealthGrade, upTo: 5 },
    { grade: 'GOOD' as HealthGrade, upTo: 10 },
    { grade: 'FAIR' as HealthGrade, upTo: 15 },
    { grade: 'POOR' as HealthGrade, upTo: 100 },
  ],
  /** On-time delivery is the one where a higher number is better. */
  onTime: [
    { grade: 'EXCELLENT' as HealthGrade, upTo: 100 },
    { grade: 'GOOD' as HealthGrade, upTo: 97 },
    { grade: 'FAIR' as HealthGrade, upTo: 94 },
    { grade: 'POOR' as HealthGrade, upTo: 90 },
  ],
};

function gradeFor(
  percent: number,
  bands: { grade: HealthGrade; upTo: number }[],
  lowerIsBetter: boolean,
): HealthGrade {
  if (lowerIsBetter) {
    return bands.find((b) => percent <= b.upTo)?.grade ?? 'POOR';
  }
  // Higher-is-better bands are listed best-first with a floor rather than a cap.
  for (const band of bands) {
    if (percent >= band.upTo) return band.grade;
  }
  return 'POOR';
}

function healthMetric(input: {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  bands: { grade: HealthGrade; upTo: number }[];
  lowerIsBetter: boolean;
  basisNoun: string;
}): HealthMetric {
  const measurable = input.denominator > 0;
  const percent = measurable ? Math.round((input.numerator / input.denominator) * 1000) / 10 : 0;
  return {
    key: input.key,
    label: input.label,
    percent,
    grade: measurable ? gradeFor(percent, input.bands, input.lowerIsBetter) : 'GOOD',
    lowerIsBetter: input.lowerIsBetter,
    bands: input.bands,
    basis: measurable
      ? `${input.numerator.toLocaleString('en-IN')} of ${input.denominator.toLocaleString('en-IN')} ${input.basisNoun}`
      : `No ${input.basisNoun} yet`,
    measurable,
  };
}

// ---------------------------------------------------------------------------
// Range helpers
// ---------------------------------------------------------------------------

function rangeBounds(key: SellerDashRange): { from: Date; to: Date; previousFrom: Date } {
  const now = new Date();
  let from: Date;
  switch (key) {
    case 'TODAY':
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'WEEK':
      from = new Date(now.getTime() - 6 * 86400000);
      break;
    case 'QUARTER':
      from = new Date(now.getTime() - 89 * 86400000);
      break;
    case 'YEAR':
      from = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      from = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const span = now.getTime() - from.getTime();
  return { from, to: now, previousFrom: new Date(from.getTime() - span) };
}

function metric(value: number, previous: number): SellerMetric {
  return {
    value,
    previous,
    changePercent: previous > 0 ? Math.round(((value - previous) / previous) * 1000) / 10 : null,
  };
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Daily buckets, or weekly once the range is long enough that a daily chart
 * would be unreadable. Every day falls in exactly one bucket, so the series
 * always sums back to the headline figure.
 */
function buildBuckets(
  from: Date,
  to: Date,
  granularity: 'DAILY' | 'WEEKLY',
): { keys: string[]; keyFor: (d: Date) => string | null } {
  const first = startOfDay(from);
  const spanDays = Math.round((startOfDay(to).getTime() - first.getTime()) / 86400000) + 1;
  const step = granularity === 'WEEKLY' ? 7 : spanDays > 92 ? 7 : 1;
  const keys: string[] = [];
  for (let i = 0; i < spanDays; i += step) {
    keys.push(dayKey(new Date(first.getTime() + i * 86400000)));
  }
  return {
    keys,
    keyFor: (d: Date) => {
      const offset = Math.floor((startOfDay(d).getTime() - first.getTime()) / 86400000);
      if (offset < 0 || offset >= spanDays) return null;
      return keys[Math.floor(offset / step)] ?? null;
    },
  };
}

/** Lines that count as a sale: paid for, not cancelled, not returned. */
const SOLD_STATUSES = ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED'] as const;

// ---------------------------------------------------------------------------

const dashQuery = z.object({
  range: z.enum(SELLER_DASH_RANGES).default('MONTH'),
  granularity: z.enum(['DAILY', 'WEEKLY']).default('DAILY'),
});

sellerDashboardRouter.get('/', async (req, res, next) => {
  try {
    const seller = req.seller!;
    const sellerId = seller.id;
    const { range, granularity } = dashQuery.parse(req.query);
    const { from, to, previousFrom } = rangeBounds(range);
    const settings = await getSettings();

    const [
      items,
      previousItems,
      allItems,
      recentOrders,
      reviews,
      previousReviews,
      balance,
      paidPayouts,
      profile,
      pendingReturns,
      lowStock,
      pendingProducts,
    ] = await Promise.all([
      prisma.orderItem.findMany({
        where: { sellerId, order: { createdAt: { gte: from, lte: to } } },
        select: {
          orderId: true,
          status: true,
          quantity: true,
          pricePaise: true,
          productId: true,
          deliveredAt: true,
          order: { select: { createdAt: true, etaTo: true } },
          product: {
            select: {
              id: true,
              title: true,
              slug: true,
              category: { select: { id: true, name: true } },
              images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
            },
          },
        },
        take: ITEM_CAP,
      }),
      prisma.orderItem.findMany({
        where: { sellerId, order: { createdAt: { gte: previousFrom, lt: from } } },
        select: { orderId: true, status: true, quantity: true, pricePaise: true },
        take: ITEM_CAP,
      }),
      // Store health reads the shop's whole history, not just this window —
      // a rate over three orders would swing wildly.
      prisma.orderItem.findMany({
        where: { sellerId },
        select: {
          status: true,
          deliveredAt: true,
          order: { select: { etaTo: true } },
          return: { select: { reasonCategory: true, status: true } },
        },
        take: ITEM_CAP,
      }),
      prisma.order.findMany({
        where: { items: { some: { sellerId } }, status: { not: 'PLACED' } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          shipName: true,
          createdAt: true,
          user: { select: { name: true } },
          items: { where: { sellerId }, select: { pricePaise: true, quantity: true } },
        },
      }),
      prisma.review.findMany({
        where: { product: { sellerId } },
        select: { rating: true, createdAt: true },
        take: ITEM_CAP,
      }),
      prisma.review.aggregate({
        where: { product: { sellerId }, createdAt: { lt: from } },
        _avg: { rating: true },
      }),
      availableBalance(sellerId),
      prisma.payout.findMany({
        where: { sellerId, status: 'PAID' },
        select: { netPaise: true, processedAt: true },
      }),
      prisma.sellerProfile.findUnique({
        where: { id: sellerId },
        select: { shopName: true, slug: true, status: true, logoUrl: true, createdAt: true },
      }),
      prisma.return.count({
        where: { orderItem: { sellerId }, status: 'REQUESTED' },
      }),
      prisma.productVariant.count({
        where: { product: { sellerId, status: { not: 'ARCHIVED' } }, stock: { lt: 5 } },
      }),
      prisma.product.count({ where: { sellerId, status: 'PENDING' } }),
    ]);

    // --- KPIs -------------------------------------------------------------
    const sold = items.filter((i) => SOLD_STATUSES.includes(i.status as never));
    const previousSold = previousItems.filter((i) => SOLD_STATUSES.includes(i.status as never));

    const salesPaise = sold.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
    const previousSales = previousSold.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
    const unitsSold = sold.reduce((sum, i) => sum + i.quantity, 0);
    const previousUnits = previousSold.reduce((sum, i) => sum + i.quantity, 0);
    const orders = new Set(sold.map((i) => i.orderId)).size;
    const previousOrders = new Set(previousSold.map((i) => i.orderId)).size;

    // Net revenue runs the same fee maths a payout does, so the number on the
    // dashboard and the number that reaches the bank agree.
    const netRevenuePaise = feesFor(salesPaise, settings).netPaise;
    const previousNet = feesFor(previousSales, settings).netPaise;

    // Counted as orders, not lines — two shirts in one parcel is one job.
    const pendingOrders = new Set(
      items.filter((i) => ['CONFIRMED', 'PACKED'].includes(i.status)).map((i) => i.orderId),
    ).size;

    const ratingAvg =
      reviews.length > 0
        ? Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10
        : null;
    const previousAvg = previousReviews._avg.rating;

    // --- Sales trend ------------------------------------------------------
    const buckets = buildBuckets(from, to, granularity);
    const trend = new Map<string, { salesPaise: number; orderIds: Set<string> }>(
      buckets.keys.map((k) => [k, { salesPaise: 0, orderIds: new Set<string>() }]),
    );
    for (const item of sold) {
      const key = buckets.keyFor(item.order.createdAt);
      const bucket = key ? trend.get(key) : undefined;
      if (!bucket) continue;
      bucket.salesPaise += item.pricePaise * item.quantity;
      bucket.orderIds.add(item.orderId);
    }

    // --- Order status ------------------------------------------------------
    // PLACED means the shopper never completed payment — the seller never sees
    // those lines anywhere else, so they stay out of the donut and out of its
    // denominator. Otherwise the slices would not add up to 100%.
    const statusItems = items.filter((i) => i.status !== 'PLACED');
    const statusTotal = statusItems.length || 1;
    const orderStatus = STATUS_BUCKETS.map((b) => {
      const count = statusItems.filter((i) => b.statuses.includes(i.status)).length;
      return {
        key: b.key,
        label: b.label,
        count,
        share: Math.round((count / statusTotal) * 1000) / 10,
      };
    }).filter((s) => s.count > 0);

    // --- Categories & products --------------------------------------------
    const byCategory = new Map<string, { name: string; units: number; salesPaise: number }>();
    const byProduct = new Map<
      string,
      { title: string; slug: string; imageUrl: string | null; units: number; salesPaise: number }
    >();
    for (const item of sold) {
      const cat = item.product.category;
      const c = byCategory.get(cat.id) ?? { name: cat.name, units: 0, salesPaise: 0 };
      c.units += item.quantity;
      c.salesPaise += item.pricePaise * item.quantity;
      byCategory.set(cat.id, c);

      const p = byProduct.get(item.productId) ?? {
        title: item.product.title,
        slug: item.product.slug,
        imageUrl: item.product.images[0]?.url ?? null,
        units: 0,
        salesPaise: 0,
      };
      p.units += item.quantity;
      p.salesPaise += item.pricePaise * item.quantity;
      byProduct.set(item.productId, p);
    }
    const categoryTotal = [...byCategory.values()].reduce((sum, c) => sum + c.units, 0) || 1;

    // --- Store health -------------------------------------------------------
    // Abandoned checkouts (PLACED) never became the seller's responsibility,
    // so they are not held against any of these rates.
    const realItems = allItems.filter((i) => i.status !== 'PLACED');
    const delivered = realItems.filter((i) => i.status === 'DELIVERED' || i.return !== null);
    const deliveredCount = delivered.length;
    const cancelled = realItems.filter((i) => i.status === 'CANCELLED').length;
    const returned = realItems.filter((i) => i.return !== null).length;
    // A defect is a return the shop caused — damaged, wrong item or quality.
    // A size return is the shopper changing their mind, not a defect.
    const defects = realItems.filter(
      (i) =>
        i.return !== null &&
        ['DAMAGED', 'WRONG_ITEM', 'QUALITY'].includes(i.return.reasonCategory) &&
        i.return.status !== 'REJECTED',
    ).length;
    const withEta = realItems.filter((i) => i.deliveredAt !== null && i.order.etaTo !== null);
    const onTime = withEta.filter((i) => i.deliveredAt! <= i.order.etaTo!).length;

    const metrics: HealthMetric[] = [
      healthMetric({
        key: 'defect',
        label: 'Order defect rate',
        numerator: defects,
        denominator: deliveredCount,
        bands: HEALTH_BANDS.defect,
        lowerIsBetter: true,
        basisNoun: 'delivered items',
      }),
      healthMetric({
        key: 'cancellation',
        label: 'Cancellation rate',
        numerator: cancelled,
        denominator: realItems.length,
        bands: HEALTH_BANDS.cancellation,
        lowerIsBetter: true,
        basisNoun: 'order lines',
      }),
      healthMetric({
        key: 'returns',
        label: 'Return rate',
        numerator: returned,
        denominator: deliveredCount,
        bands: HEALTH_BANDS.returns,
        lowerIsBetter: true,
        basisNoun: 'delivered items',
      }),
      healthMetric({
        key: 'onTime',
        label: 'On-time delivery',
        numerator: onTime,
        denominator: withEta.length,
        bands: HEALTH_BANDS.onTime,
        lowerIsBetter: false,
        basisNoun: 'items with a promised date',
      }),
    ];

    const measured = metrics.filter((m) => m.measurable);
    const gradePoints: Record<HealthGrade, number> = {
      EXCELLENT: 100,
      GOOD: 80,
      FAIR: 55,
      POOR: 25,
    };
    const scorePercent =
      measured.length > 0
        ? Math.round(measured.reduce((sum, m) => sum + gradePoints[m.grade], 0) / measured.length)
        : null;

    // --- Payouts -----------------------------------------------------------
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const thisMonthPaise = paidPayouts
      .filter((p) => p.processedAt && p.processedAt >= startOfMonth)
      .reduce((sum, p) => sum + p.netPaise, 0);
    const lifetimePaidPaise = paidPayouts.reduce((sum, p) => sum + p.netPaise, 0);

    const blockedReason =
      seller.status !== 'APPROVED'
        ? 'Your shop is not approved yet'
        : balance.payablePaise < settings.payoutMinPaise
          ? `Minimum withdrawal is ₹${(settings.payoutMinPaise / 100).toLocaleString('en-IN')}`
          : null;

    // --- Actions ------------------------------------------------------------
    const actions: SellerDashboard['actions'] = [
      {
        key: 'pending-orders',
        label: 'orders to pack or ship',
        count: pendingOrders,
        href: '/seller/orders',
        tone: 'WARN' as const,
      },
      {
        key: 'returns',
        label: 'returns awaiting your decision',
        count: pendingReturns,
        href: '/seller/returns',
        tone: 'WARN' as const,
      },
      {
        key: 'low-stock',
        label: 'variants low on stock',
        count: lowStock,
        href: '/seller/inventory',
        tone: 'INFO' as const,
      },
      {
        key: 'pending-products',
        label: 'listings waiting for approval',
        count: pendingProducts,
        href: '/seller/products',
        tone: 'INFO' as const,
      },
    ].filter((a) => a.count > 0);

    const body: SellerDashboard = {
      range: {
        key: range,
        label: SELLER_DASH_RANGE_LABELS[range],
        from: from.toISOString(),
        to: to.toISOString(),
      },
      store: {
        shopName: profile?.shopName ?? 'Your shop',
        // A short, stable public reference the seller can quote to support.
        sellerCode: `CLW-${sellerId.slice(-6).toUpperCase()}`,
        slug: profile?.slug ?? null,
        status: profile?.status ?? 'PENDING',
        logoUrl: profile?.logoUrl ?? null,
      },
      kpis: {
        salesPaise: metric(salesPaise, previousSales),
        orders: metric(orders, previousOrders),
        unitsSold: metric(unitsSold, previousUnits),
        netRevenuePaise: metric(netRevenuePaise, previousNet),
        pendingOrders,
        rating: {
          average: ratingAvg,
          count: reviews.length,
          changeVsPrevious:
            ratingAvg !== null && previousAvg
              ? Math.round((ratingAvg - previousAvg) * 10) / 10
              : null,
        },
      },
      salesTrend: [...trend.entries()].map(([date, v]) => ({
        date,
        salesPaise: v.salesPaise,
        orders: v.orderIds.size,
      })),
      orderStatus,
      topCategories: [...byCategory.entries()]
        .map(([id, c]) => ({
          id,
          name: c.name,
          unitsSold: c.units,
          salesPaise: c.salesPaise,
          share: Math.round((c.units / categoryTotal) * 1000) / 10,
        }))
        .sort((a, b) => b.unitsSold - a.unitsSold)
        .slice(0, 5),
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customerName: o.user.name ?? o.shipName,
        amountPaise: o.items.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0),
        status: o.status,
        statusLabel: ORDER_STATUS_LABELS[o.status] ?? o.status,
        itemCount: o.items.length,
        createdAt: o.createdAt.toISOString(),
      })),
      productPerformance: [...byProduct.entries()]
        .map(([id, p]) => ({
          id,
          title: p.title,
          slug: p.slug,
          imageUrl: p.imageUrl,
          unitsSold: p.units,
          salesPaise: p.salesPaise,
        }))
        .sort((a, b) => b.unitsSold - a.unitsSold)
        .slice(0, 5),
      payouts: {
        lifetimePaidPaise,
        thisMonthPaise,
        availablePaise: balance.payablePaise,
        inClearingPaise: balance.inClearingPaise,
        nextClearingAt: balance.nextClearingAt,
        minWithdrawalPaise: settings.payoutMinPaise,
        canWithdraw: blockedReason === null,
        blockedReason,
      },
      health: { scorePercent, metrics },
      actions,
    };

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
