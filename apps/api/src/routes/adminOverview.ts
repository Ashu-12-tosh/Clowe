import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs/promises';
import {
  OVERVIEW_RANGES,
  OVERVIEW_RANGE_LABELS,
  type AdminOverview,
  type OverviewMetric,
  type OverviewRange,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { getSettings } from '../services/settingsService';
import { paymentProvider } from '../services/payments';
import { shippingProvider } from '../services/shipping';
import { payoutProvider } from '../services/payouts';
import { aiProvider } from '../services/ai';
import { tryOnProvider } from '../services/tryon';
import { uploadDir } from './uploads';

export const adminOverviewRouter = Router();
adminOverviewRouter.use(requireAuth, requireRole('ADMIN'));

const ORDER_STATUS_LABELS: Record<string, string> = {
  PLACED: 'Awaiting payment',
  CONFIRMED: 'Confirmed',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURN_REQUESTED: 'Return requested',
  RETURNED: 'Returned',
};

function rangeBounds(key: OverviewRange): { from: Date; to: Date; previousFrom: Date } {
  const now = new Date();
  const to = now;
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
  const span = to.getTime() - from.getTime();
  return { from, to, previousFrom: new Date(from.getTime() - span) };
}

function metric(value: number, previous: number): OverviewMetric {
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
 * Daily buckets for short ranges, weekly once a year's worth of days would make
 * the chart unreadable. Every day in the range lands in exactly one bucket, so
 * the series always adds up to the headline figure.
 */
function buildBuckets(
  from: Date,
  to: Date,
): { keys: string[]; keyFor: (d: Date) => string | null } {
  const first = startOfDay(from);
  const last = startOfDay(to);
  const spanDays = Math.round((last.getTime() - first.getTime()) / 86400000) + 1;
  const step = spanDays > 92 ? 7 : 1;
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

adminOverviewRouter.get('/', async (req, res, next) => {
  try {
    const { range } = z
      .object({ range: z.enum(OVERVIEW_RANGES).default('MONTH') })
      .parse(req.query);
    const { from, to, previousFrom } = rangeBounds(range);
    const settings = await getSettings();

    const [
      items,
      previousItems,
      users,
      previousUsers,
      sellers,
      products,
      previousProducts,
      orderStatusGroups,
      recentOrders,
      newSellers,
      tryOns,
      previousTryOns,
      totals,
      pending,
    ] = await Promise.all([
      // Order lines in range, with everything the panels need.
      prisma.orderItem.findMany({
        where: { order: { status: { not: 'PLACED' }, createdAt: { gte: from, lte: to } } },
        select: {
          sellerId: true,
          orderId: true,
          status: true,
          quantity: true,
          pricePaise: true,
          productId: true,
          order: { select: { createdAt: true, userId: true } },
          product: { select: { category: { select: { id: true, name: true } } } },
        },
      }),
      prisma.orderItem.findMany({
        where: { order: { status: { not: 'PLACED' }, createdAt: { gte: previousFrom, lt: from } } },
        select: { orderId: true, status: true, pricePaise: true, quantity: true },
      }),
      prisma.user.count({ where: { createdAt: { gte: from, lte: to } } }),
      prisma.user.count({ where: { createdAt: { gte: previousFrom, lt: from } } }),
      prisma.sellerProfile.findMany({
        select: {
          id: true,
          shopName: true,
          status: true,
          createdAt: true,
          user: { select: { email: true } },
        },
      }),
      prisma.product.count({
        where: { status: { not: 'ARCHIVED' }, createdAt: { gte: from, lte: to } },
      }),
      prisma.product.count({
        where: { status: { not: 'ARCHIVED' }, createdAt: { gte: previousFrom, lt: from } },
      }),
      prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: {
          user: { select: { name: true } },
          payment: { select: { status: true } },
          items: { select: { seller: { select: { shopName: true } } } },
        },
      }),
      prisma.sellerProfile.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          shopName: true,
          status: true,
          createdAt: true,
          user: { select: { email: true } },
        },
      }),
      prisma.tryOnHistory.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: { status: true, createdAt: true, userId: true, productId: true },
      }),
      prisma.tryOnHistory.count({ where: { createdAt: { gte: previousFrom, lt: from } } }),
      Promise.all([
        prisma.user.count(),
        prisma.sellerProfile.count(),
        prisma.product.count({ where: { status: { not: 'ARCHIVED' } } }),
        prisma.order.count(),
        prisma.return.count(),
      ]),
      Promise.all([
        prisma.sellerProfile.count({ where: { status: 'PENDING' } }),
        prisma.product.count({ where: { status: 'PENDING' } }),
        prisma.complaint.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
        prisma.return.count({ where: { status: 'REQUESTED' } }),
        prisma.payout.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
      ]),
    ]);

    // --- GMV / revenue ------------------------------------------------------
    const counted = items.filter((i) => !['CANCELLED', 'RETURNED'].includes(i.status));
    const gmvPaise = counted.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
    const previousGmv = previousItems
      .filter((i) => !['CANCELLED', 'RETURNED'].includes(i.status))
      .reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);

    // The marketplace keeps commission + gateway charges, not the whole GMV.
    const takeRate = (settings.payoutCommissionPercent + settings.payoutGatewayPercent) / 100;
    const revenuePaise = Math.round(gmvPaise * takeRate);
    const previousRevenue = Math.round(previousGmv * takeRate);

    // Counted the same way as GMV: an order that was entirely cancelled or
    // returned is not a sale, so it must not inflate the order count either.
    const orders = new Set(counted.map((i) => i.orderId)).size;
    const previousOrders = new Set(
      previousItems
        .filter((i) => !['CANCELLED', 'RETURNED'].includes(i.status))
        .map((i) => i.orderId),
    ).size;

    const activeSellers = sellers.filter((s) => s.status === 'APPROVED').length;
    const previousActiveSellers = sellers.filter(
      (s) => s.status === 'APPROVED' && s.createdAt < from,
    ).length;

    // --- Sales series -------------------------------------------------------
    const buckets = buildBuckets(from, to);
    const series = new Map<string, { gmvPaise: number; orderIds: Set<string> }>(
      buckets.keys.map((k) => [k, { gmvPaise: 0, orderIds: new Set<string>() }]),
    );
    for (const item of counted) {
      const key = buckets.keyFor(item.order.createdAt);
      const bucket = key ? series.get(key) : undefined;
      if (!bucket) continue;
      bucket.gmvPaise += item.pricePaise * item.quantity;
      bucket.orderIds.add(item.orderId);
    }

    // --- Categories & sellers ----------------------------------------------
    const categoryGmv = new Map<string, { name: string; gmvPaise: number }>();
    const sellerGmv = new Map<string, { gmvPaise: number; orderIds: Set<string> }>();
    for (const item of counted) {
      const cat = item.product.category;
      const entry = categoryGmv.get(cat.id) ?? { name: cat.name, gmvPaise: 0 };
      entry.gmvPaise += item.pricePaise * item.quantity;
      categoryGmv.set(cat.id, entry);

      const seller = sellerGmv.get(item.sellerId) ?? { gmvPaise: 0, orderIds: new Set<string>() };
      seller.gmvPaise += item.pricePaise * item.quantity;
      seller.orderIds.add(item.orderId);
      sellerGmv.set(item.sellerId, seller);
    }
    const shopNames = new Map(sellers.map((s) => [s.id, s.shopName]));

    // Seller ratings come from real reviews, not the product rating cache.
    const reviewRows = await prisma.review.findMany({
      select: { rating: true, product: { select: { sellerId: true } } },
    });
    const ratings = new Map<string, { sum: number; count: number }>();
    for (const r of reviewRows) {
      const entry = ratings.get(r.product.sellerId) ?? { sum: 0, count: 0 };
      entry.sum += r.rating;
      entry.count += 1;
      ratings.set(r.product.sellerId, entry);
    }

    // --- Try-On -------------------------------------------------------------
    const tryOnTrend = new Map<string, number>(buckets.keys.map((k) => [k, 0]));
    for (const t of tryOns) {
      const key = buckets.keyFor(t.createdAt);
      if (key !== null && tryOnTrend.has(key)) tryOnTrend.set(key, (tryOnTrend.get(key) ?? 0) + 1);
    }
    // Conversion = the same shopper who tried a garment on later bought it.
    const orderedPairs = new Set(items.map((i) => `${i.order.userId}:${i.productId}`));
    const tryOnPairs = new Set(tryOns.map((t) => `${t.userId}:${t.productId}`));
    const converted = [...tryOnPairs].filter((pair) => orderedPairs.has(pair)).length;

    // --- System health ------------------------------------------------------
    const checks: AdminOverview['systemHealth']['checks'] = [];
    let dbOk = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbOk = false;
    }
    checks.push({
      key: 'database',
      label: 'Database',
      status: dbOk ? 'OPERATIONAL' : 'DOWN',
      detail: dbOk ? 'Responding' : 'Query failed',
    });

    let storageOk = true;
    try {
      await fs.access(uploadDir, fs.constants.W_OK);
    } catch {
      storageOk = false;
    }
    checks.push({
      key: 'storage',
      label: 'Image storage',
      status: storageOk ? 'OPERATIONAL' : 'DOWN',
      detail: storageOk ? 'Upload directory writable' : 'Upload directory not writable',
    });

    for (const [key, label, name] of [
      ['payments', 'Payment gateway', paymentProvider.name],
      ['shipping', 'Shipping partner', shippingProvider.name],
      ['payouts', 'Payouts', payoutProvider.name],
      ['ai', 'AI services', aiProvider.name],
      ['tryon', 'AI Try-On', tryOnProvider.name],
    ] as const) {
      checks.push({
        key,
        label,
        // A mock provider works, but calling it "operational" would overstate it.
        status: name === 'mock' ? 'SANDBOX' : 'OPERATIONAL',
        detail: name === 'mock' ? 'Sandbox provider' : `Live via ${name}`,
      });
    }

    const stuckTryOns = await prisma.tryOnHistory.count({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 120000) } },
    });
    if (stuckTryOns > 0) {
      checks.push({
        key: 'queue',
        label: 'Try-On queue',
        status: 'DEGRADED',
        detail: `${stuckTryOns} run(s) pending over 2 min`,
      });
    }

    // --- Risk alerts --------------------------------------------------------
    const [failedPayments, breachedTickets, disputedReturns, highReturnSellers] = await Promise.all(
      [
        prisma.payment.count({
          where: { status: 'FAILED', createdAt: { gte: from, lte: to } },
        }),
        prisma.complaint.count({
          where: {
            status: { in: ['OPEN', 'IN_PROGRESS'] },
            firstResponseAt: null,
            slaDueAt: { lt: new Date() },
          },
        }),
        prisma.return.count({ where: { status: 'REJECTED', adminOverrideAt: null } }),
        prisma.sellerProfile.count({ where: { status: 'SUSPENDED' } }),
      ],
    );

    const body: AdminOverview = {
      range: {
        key: range,
        label: OVERVIEW_RANGE_LABELS[range],
        from: from.toISOString(),
        to: to.toISOString(),
      },
      kpis: {
        gmvPaise: metric(gmvPaise, previousGmv),
        orders: metric(orders, previousOrders),
        users: metric(users, previousUsers),
        activeSellers: metric(activeSellers, previousActiveSellers),
        products: metric(products, previousProducts),
        revenuePaise: metric(revenuePaise, previousRevenue),
      },
      salesTrend: [...series.entries()].map(([date, v]) => ({
        date,
        gmvPaise: v.gmvPaise,
        orders: v.orderIds.size,
      })),
      orderStatus: (() => {
        const total = orderStatusGroups.reduce((sum, g) => sum + g._count._all, 0);
        return orderStatusGroups
          .map((g) => ({
            key: g.status,
            label: ORDER_STATUS_LABELS[g.status] ?? g.status,
            count: g._count._all,
            share: total > 0 ? Math.round((g._count._all / total) * 1000) / 10 : 0,
          }))
          .sort((a, b) => b.count - a.count);
      })(),
      topCategories: (() => {
        const total = [...categoryGmv.values()].reduce((sum, c) => sum + c.gmvPaise, 0);
        return [...categoryGmv.entries()]
          .map(([id, c]) => ({
            id,
            name: c.name,
            gmvPaise: c.gmvPaise,
            share: total > 0 ? Math.round((c.gmvPaise / total) * 1000) / 10 : 0,
          }))
          .sort((a, b) => b.gmvPaise - a.gmvPaise)
          .slice(0, 6);
      })(),
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customerName: o.user.name ?? o.shipName,
        sellerNames: [...new Set(o.items.map((i) => i.seller.shopName))].slice(0, 2),
        amountPaise: o.totalPaise,
        paymentStatus: o.payment?.status ?? (o.paymentMethod === 'COD' ? 'COD_PENDING' : 'CREATED'),
        status: o.status,
        createdAt: o.createdAt.toISOString(),
      })),
      newSellers: newSellers.map((s) => ({
        id: s.id,
        shopName: s.shopName,
        email: s.user.email,
        status: s.status,
        joinedAt: s.createdAt.toISOString(),
      })),
      topSellers: [...sellerGmv.entries()]
        .map(([id, v]) => {
          const rating = ratings.get(id);
          return {
            id,
            shopName: shopNames.get(id) ?? 'Unknown shop',
            gmvPaise: v.gmvPaise,
            orders: v.orderIds.size,
            ratingAvg:
              rating && rating.count > 0 ? Math.round((rating.sum / rating.count) * 10) / 10 : null,
          };
        })
        .sort((a, b) => b.gmvPaise - a.gmvPaise)
        .slice(0, 5),
      tryOn: {
        sessions: tryOns.length,
        sessionsChangePercent:
          previousTryOns > 0
            ? Math.round(((tryOns.length - previousTryOns) / previousTryOns) * 1000) / 10
            : null,
        successful: tryOns.filter((t) => t.status === 'SUCCESS').length,
        conversionRate:
          tryOnPairs.size > 0 ? Math.round((converted / tryOnPairs.size) * 1000) / 10 : 0,
        trend: [...tryOnTrend.entries()].map(([date, count]) => ({ date, count })),
      },
      systemHealth: {
        overall: checks.some((c) => c.status === 'DOWN')
          ? 'DOWN'
          : checks.some((c) => c.status === 'DEGRADED')
            ? 'DEGRADED'
            : 'OPERATIONAL',
        checks,
      },
      riskAlerts: [
        {
          key: 'failed-payments',
          label: 'Failed payments',
          count: failedPayments,
          detail: 'Payment attempts that did not complete in this range',
          href: '/admin/orders',
        },
        {
          key: 'sla-breach',
          label: 'Support SLA breaches',
          count: breachedTickets,
          detail: 'Open tickets past their first-response target',
          href: '/admin/support',
        },
        {
          key: 'disputed-returns',
          label: 'Rejected returns',
          count: disputedReturns,
          detail: 'Seller-rejected returns with no admin review',
          href: '/admin/returns',
        },
        {
          key: 'suspended-sellers',
          label: 'Suspended sellers',
          count: highReturnSellers,
          detail: 'Shops currently blocked from selling',
          href: '/admin/sellers?status=SUSPENDED',
        },
      ],
      platformSummary: {
        users: totals[0],
        sellers: totals[1],
        products: totals[2],
        orders: totals[3],
        returns: totals[4],
        revenuePaise,
      },
      pending: {
        sellers: pending[0],
        products: pending[1],
        tickets: pending[2],
        returns: pending[3],
        payouts: pending[4],
      },
    };

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
