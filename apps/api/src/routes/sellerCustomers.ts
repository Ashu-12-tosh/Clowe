import { Router } from 'express';
import { z } from 'zod';
import {
  CUSTOMER_SEGMENTS,
  CUSTOMER_SEGMENT_LABELS,
  CUSTOMER_SEGMENT_RULES,
  CUSTOMER_SORTS,
  CUSTOMER_STATUSES,
  CUSTOMER_STATUS_LABELS,
  RETURN_REASON_LABELS,
  type CustomerSegment,
  type CustomerSort,
  type CustomerStatus,
  type ReturnReasonValue,
  type SellerCustomerDetail,
  type SellerCustomerPage,
  type SellerCustomerRow,
  type SellerCustomerSummary,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { requireSeller } from './seller';

export const sellerCustomersRouter = Router();
sellerCustomersRouter.use(requireAuth, requireSeller);

/** A shopper with no order in this many days is drifting away. */
const AT_RISK_DAYS = 90;
/** No order in this long and we treat them as gone. */
const DORMANT_DAYS = 180;
/** A first order this recent still counts as "new". */
const NEW_DAYS = 30;
/** Top slice of lifetime spend that earns the high-value badge. */
const HIGH_VALUE_PERCENTILE = 0.2;

const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  segment: z.enum(['ALL', ...CUSTOMER_SEGMENTS]).default('ALL'),
  status: z.enum(['ALL', ...CUSTOMER_STATUSES]).default('ALL'),
  city: z.string().trim().optional(),
  sort: z.enum(CUSTOMER_SORTS).default('LTV_HIGH'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
});

interface CustomerAccumulator {
  userId: string;
  name: string;
  email: string | null;
  phone: string;
  city: string | null;
  state: string | null;
  orders: Set<string>;
  unitsBought: number;
  returnedUnits: number;
  ltvPaise: number;
  firstOrderAt: Date;
  lastOrderAt: Date;
  returnCount: number;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

/**
 * Every shopper who has bought from this shop, with their totals. Cancelled
 * and returned lines are excluded from spend but still counted as history.
 */
async function loadCustomers(sellerId: string): Promise<CustomerAccumulator[]> {
  const items = await prisma.orderItem.findMany({
    where: { sellerId, order: { status: { not: 'PLACED' } } },
    select: {
      status: true,
      quantity: true,
      pricePaise: true,
      order: {
        select: {
          id: true,
          createdAt: true,
          shipCity: true,
          shipState: true,
          user: { select: { id: true, name: true, phone: true, email: true } },
        },
      },
      return: { select: { id: true } },
    },
  });

  const map = new Map<string, CustomerAccumulator>();
  for (const item of items) {
    const user = item.order.user;
    const entry =
      map.get(user.id) ??
      ({
        userId: user.id,
        name: user.name ?? 'Customer',
        email: user.email,
        phone: user.phone,
        city: item.order.shipCity,
        state: item.order.shipState,
        orders: new Set<string>(),
        unitsBought: 0,
        returnedUnits: 0,
        ltvPaise: 0,
        firstOrderAt: item.order.createdAt,
        lastOrderAt: item.order.createdAt,
        returnCount: 0,
      } satisfies CustomerAccumulator);

    entry.orders.add(item.order.id);
    entry.unitsBought += item.quantity;
    if (!['CANCELLED', 'RETURNED'].includes(item.status)) {
      entry.ltvPaise += item.pricePaise * item.quantity;
    }
    if (item.status === 'RETURNED' || item.status === 'RETURN_REQUESTED') {
      entry.returnedUnits += item.quantity;
    }
    if (item.return) entry.returnCount += 1;
    if (item.order.createdAt < entry.firstOrderAt) entry.firstOrderAt = item.order.createdAt;
    if (item.order.createdAt > entry.lastOrderAt) {
      entry.lastOrderAt = item.order.createdAt;
      // Keep the most recent destination — that's where they live today.
      entry.city = item.order.shipCity;
      entry.state = item.order.shipState;
    }
    map.set(user.id, entry);
  }
  return [...map.values()];
}

/** Lifetime-spend cut-off for the top HIGH_VALUE_PERCENTILE of customers. */
function highValueThreshold(customers: CustomerAccumulator[]): number {
  if (customers.length === 0) return 0;
  const sorted = [...customers].map((c) => c.ltvPaise).sort((a, b) => b - a);
  const index = Math.max(0, Math.ceil(sorted.length * HIGH_VALUE_PERCENTILE) - 1);
  return sorted[index] ?? 0;
}

function statusOf(daysSince: number): CustomerStatus {
  if (daysSince >= DORMANT_DAYS) return 'DORMANT';
  if (daysSince >= AT_RISK_DAYS) return 'AT_RISK';
  return 'ACTIVE';
}

function segmentOf(
  customer: CustomerAccumulator,
  daysSince: number,
  daysSinceFirst: number,
  threshold: number,
): CustomerSegment {
  // Drifting away is the most actionable label, so it wins the chip.
  if (daysSince >= AT_RISK_DAYS) return 'AT_RISK';
  if (threshold > 0 && customer.ltvPaise >= threshold) return 'HIGH_VALUE';
  if (customer.orders.size >= 2) return 'REPEAT';
  if (customer.orders.size === 1 && daysSinceFirst <= NEW_DAYS) return 'NEW';
  return 'REGULAR';
}

function toRow(
  customer: CustomerAccumulator,
  threshold: number,
  now: Date,
): SellerCustomerRow {
  const daysSince = daysBetween(customer.lastOrderAt, now);
  const daysSinceFirst = daysBetween(customer.firstOrderAt, now);
  const segment = segmentOf(customer, daysSince, daysSinceFirst, threshold);
  const status = statusOf(daysSince);
  const orderCount = customer.orders.size;
  return {
    userId: customer.userId,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    city: customer.city,
    state: customer.state,
    segment,
    segmentLabel: CUSTOMER_SEGMENT_LABELS[segment],
    status,
    statusLabel: CUSTOMER_STATUS_LABELS[status],
    orderCount,
    unitsBought: customer.unitsBought,
    ltvPaise: customer.ltvPaise,
    avgOrderValuePaise: orderCount > 0 ? Math.round(customer.ltvPaise / orderCount) : 0,
    firstOrderAt: customer.firstOrderAt.toISOString(),
    lastOrderAt: customer.lastOrderAt.toISOString(),
    daysSinceLastOrder: daysSince,
    returnCount: customer.returnCount,
    returnRate:
      customer.unitsBought > 0
        ? Math.round((customer.returnedUnits / customer.unitsBought) * 1000) / 10
        : 0,
  };
}

function compare(a: SellerCustomerRow, b: SellerCustomerRow, sort: CustomerSort): number {
  switch (sort) {
    case 'LTV_LOW':
      return a.ltvPaise - b.ltvPaise;
    case 'ORDERS_HIGH':
      return b.orderCount - a.orderCount;
    case 'RECENT':
      return b.lastOrderAt.localeCompare(a.lastOrderAt);
    case 'OLDEST':
      return a.firstOrderAt.localeCompare(b.firstOrderAt);
    default:
      return b.ltvPaise - a.ltvPaise;
  }
}

async function loadRows(
  sellerId: string,
  query: z.infer<typeof listQuery>,
): Promise<{ rows: SellerCustomerRow[]; thresholdPaise: number }> {
  const customers = await loadCustomers(sellerId);
  const thresholdPaise = highValueThreshold(customers);
  const now = new Date();

  const q = query.q?.toLowerCase();
  const rows = customers
    .map((c) => toRow(c, thresholdPaise, now))
    .filter((row) => {
      if (query.segment !== 'ALL' && row.segment !== query.segment) return false;
      if (query.status !== 'ALL' && row.status !== query.status) return false;
      if (query.city && (row.city ?? '').toLowerCase() !== query.city.toLowerCase()) return false;
      if (q) {
        const haystack = `${row.name} ${row.email ?? ''} ${row.phone} ${row.city ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => compare(a, b, query.sort));

  return { rows, thresholdPaise };
}

// ---------------------------------------------------------------------------
// GET / — the customers table
// ---------------------------------------------------------------------------

sellerCustomersRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const { rows } = await loadRows(req.seller!.id, query);
    const body: SellerCustomerPage = {
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
// GET /summary — KPIs, segments, frequency, cities, insights
// ---------------------------------------------------------------------------

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

const FREQUENCY_BUCKETS: { key: string; label: string; test: (n: number) => boolean }[] = [
  { key: '1', label: '1 order', test: (n) => n === 1 },
  { key: '2-5', label: '2–5 orders', test: (n) => n >= 2 && n <= 5 },
  { key: '6-10', label: '6–10 orders', test: (n) => n >= 6 && n <= 10 },
  { key: '11+', label: '11+ orders', test: (n) => n >= 11 },
];

sellerCustomersRouter.get('/summary', async (req, res, next) => {
  try {
    const { rows, thresholdPaise } = await loadRows(req.seller!.id, listQuery.parse({}));
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const firstOrderIn = (from: Date, to?: Date) =>
      rows.filter((r) => {
        const at = new Date(r.firstOrderAt);
        return at >= from && (!to || at < to);
      }).length;

    const newThisMonth = firstOrderIn(monthStart);
    const repeat = rows.filter((r) => r.orderCount >= 2).length;
    const orders = rows.reduce((sum, r) => sum + r.orderCount, 0);
    const ltvTotal = rows.reduce((sum, r) => sum + r.ltvPaise, 0);
    const unitsTotal = rows.reduce((sum, r) => sum + r.unitsBought, 0);
    const returnedTotal = rows.reduce(
      (sum, r) => sum + Math.round((r.returnRate / 100) * r.unitsBought),
      0,
    );

    const segmentCounts = new Map<CustomerSegment, number>();
    for (const row of rows) {
      segmentCounts.set(row.segment, (segmentCounts.get(row.segment) ?? 0) + 1);
    }

    const cityCounts = new Map<string, number>();
    for (const row of rows) {
      if (!row.city) continue;
      const city = row.city.charAt(0).toUpperCase() + row.city.slice(1);
      cityCounts.set(city, (cityCounts.get(city) ?? 0) + 1);
    }

    const atRisk = rows.filter((r) => r.segment === 'AT_RISK');
    const highValue = rows.filter((r) => r.segment === 'HIGH_VALUE');
    const insights: SellerCustomerSummary['insights'] = [];
    if (rows.length > 0) {
      const repeatRate = Math.round((repeat / rows.length) * 1000) / 10;
      insights.push({
        key: 'repeat',
        tone: repeatRate >= 25 ? 'GOOD' : 'INFO',
        title: `${repeatRate}% of your customers ordered more than once`,
        body:
          repeatRate >= 25
            ? 'Retention is healthy — keep serving these shoppers well.'
            : 'Most shoppers buy once. A follow-up offer could bring them back.',
      });
    }
    if (atRisk.length > 0) {
      insights.push({
        key: 'at-risk',
        tone: 'WARN',
        title: `Win back ${atRisk.length} at-risk customer(s)`,
        body: `They haven't ordered in over ${AT_RISK_DAYS} days. A targeted promotion is the cheapest way back.`,
      });
    }
    if (highValue.length > 0) {
      const share = Math.round((highValue.reduce((s, r) => s + r.ltvPaise, 0) / ltvTotal) * 100);
      insights.push({
        key: 'high-value',
        tone: 'GOOD',
        title: `Your top ${highValue.length} customers drive ${share}% of revenue`,
        body: `Anyone above ${Math.round(thresholdPaise / 100).toLocaleString('en-IN')} rupees lifetime spend counts as high value.`,
      });
    }

    const body: SellerCustomerSummary = {
      kpis: {
        total: rows.length,
        totalChangePercent: changePercent(newThisMonth, firstOrderIn(prevMonthStart, monthStart)),
        newThisMonth,
        newChangePercent: changePercent(newThisMonth, firstOrderIn(prevMonthStart, monthStart)),
        repeat,
        repeatRate: rows.length > 0 ? Math.round((repeat / rows.length) * 1000) / 10 : 0,
        avgLtvPaise: rows.length > 0 ? Math.round(ltvTotal / rows.length) : 0,
        orders,
        returnRate: unitsTotal > 0 ? Math.round((returnedTotal / unitsTotal) * 1000) / 10 : 0,
      },
      segments: CUSTOMER_SEGMENTS.map((key) => ({
        key,
        label: CUSTOMER_SEGMENT_LABELS[key],
        rule: CUSTOMER_SEGMENT_RULES[key],
        count: segmentCounts.get(key) ?? 0,
        share:
          rows.length > 0 ? Math.round(((segmentCounts.get(key) ?? 0) / rows.length) * 1000) / 10 : 0,
      })).filter((s) => s.count > 0),
      frequency: FREQUENCY_BUCKETS.map((bucket) => {
        const count = rows.filter((r) => bucket.test(r.orderCount)).length;
        return {
          key: bucket.key,
          label: bucket.label,
          count,
          share: rows.length > 0 ? Math.round((count / rows.length) * 1000) / 10 : 0,
        };
      }).filter((f) => f.count > 0),
      topCities: [...cityCounts.entries()]
        .map(([city, count]) => ({
          city,
          count,
          share: rows.length > 0 ? Math.round((count / rows.length) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      topCustomers: rows
        .slice()
        .sort((a, b) => b.ltvPaise - a.ltvPaise)
        .slice(0, 5)
        .map((r) => ({
          userId: r.userId,
          name: r.name,
          orderCount: r.orderCount,
          ltvPaise: r.ltvPaise,
        })),
      insights,
      highValueThresholdPaise: thresholdPaise,
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

sellerCustomersRouter.get('/export', async (req, res, next) => {
  try {
    const { rows } = await loadRows(req.seller!.id, listQuery.parse(req.query));
    const header = [
      'Customer',
      'Phone',
      'Email',
      'City',
      'State',
      'Segment',
      'Status',
      'Orders',
      'Units',
      'Lifetime value (INR)',
      'Average order (INR)',
      'First order',
      'Last order',
      'Days since last order',
      'Returns',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.name,
          row.phone,
          row.email ?? '',
          row.city ?? '',
          row.state ?? '',
          row.segment,
          row.status,
          row.orderCount,
          row.unitsBought,
          (row.ltvPaise / 100).toFixed(2),
          (row.avgOrderValuePaise / 100).toFixed(2),
          row.firstOrderAt,
          row.lastOrderAt,
          row.daysSinceLastOrder,
          row.returnCount,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clowe-customers.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:userId — one customer's history with this shop
// ---------------------------------------------------------------------------

sellerCustomersRouter.get('/:userId', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const { rows, thresholdPaise } = await loadRows(sellerId, listQuery.parse({}));
    const row = rows.find((r) => r.userId === req.params.userId);
    if (!row) throw ApiError.notFound('This shopper has not ordered from you');
    void thresholdPaise;

    const [user, items, returns] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.params.userId },
        select: { createdAt: true },
      }),
      prisma.orderItem.findMany({
        where: { sellerId, order: { userId: req.params.userId, status: { not: 'PLACED' } } },
        orderBy: { order: { createdAt: 'desc' } },
        select: {
          status: true,
          quantity: true,
          pricePaise: true,
          productId: true,
          title: true,
          order: { select: { id: true, orderNumber: true, createdAt: true, status: true } },
          product: { select: { category: { select: { name: true } } } },
        },
      }),
      prisma.return.findMany({
        where: { orderItem: { sellerId }, userId: req.params.userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          orderItem: { select: { title: true, order: { select: { orderNumber: true } } } },
        },
      }),
    ]);

    const orders = new Map<
      string,
      { orderId: string; orderNumber: string; placedAt: string; status: string; itemCount: number; amountPaise: number }
    >();
    const categories = new Map<string, { unitsBought: number; spentPaise: number }>();
    const products = new Map<string, { title: string; unitsBought: number; spentPaise: number }>();

    for (const item of items) {
      const entry = orders.get(item.order.id) ?? {
        orderId: item.order.id,
        orderNumber: item.order.orderNumber,
        placedAt: item.order.createdAt.toISOString(),
        status: item.order.status,
        itemCount: 0,
        amountPaise: 0,
      };
      entry.itemCount += 1;
      entry.amountPaise += item.pricePaise * item.quantity;
      orders.set(item.order.id, entry);

      if (['CANCELLED', 'RETURNED'].includes(item.status)) continue;
      const catName = item.product.category.name;
      const cat = categories.get(catName) ?? { unitsBought: 0, spentPaise: 0 };
      cat.unitsBought += item.quantity;
      cat.spentPaise += item.pricePaise * item.quantity;
      categories.set(catName, cat);

      const prod = products.get(item.productId) ?? {
        title: item.title,
        unitsBought: 0,
        spentPaise: 0,
      };
      prod.unitsBought += item.quantity;
      prod.spentPaise += item.pricePaise * item.quantity;
      products.set(item.productId, prod);
    }

    const body: SellerCustomerDetail = {
      ...row,
      joinedAt: user?.createdAt.toISOString() ?? row.firstOrderAt,
      orders: [...orders.values()].slice(0, 20),
      topCategories: [...categories.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.spentPaise - a.spentPaise)
        .slice(0, 5),
      topProducts: [...products.entries()]
        .map(([productId, v]) => ({ productId, ...v }))
        .sort((a, b) => b.spentPaise - a.spentPaise)
        .slice(0, 5),
      returns: returns.map((r) => ({
        id: r.id,
        orderNumber: r.orderItem.order.orderNumber,
        title: r.orderItem.title,
        reasonLabel: RETURN_REASON_LABELS[r.reasonCategory as ReturnReasonValue],
        status: r.status,
        requestedAt: r.createdAt.toISOString(),
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
