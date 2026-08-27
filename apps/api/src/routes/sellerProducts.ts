import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  LISTING_STATES,
  LISTING_STATE_LABELS,
  SELLER_PRODUCT_SORTS,
  type ListingState,
  type SellerCatalogSummary,
  type SellerProductPage,
  type SellerProductRow,
  type SellerProductSort,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { requireSeller } from './seller';

export const sellerProductsRouter = Router();
sellerProductsRouter.use(requireAuth, requireSeller);

/** A seller's catalogue is small enough to rank in memory. */
const SCAN_CAP = 2000;
const VIEW_WINDOW_DAYS = 30;

const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  categoryId: z.string().trim().optional(),
  state: z.enum(['ALL', ...LISTING_STATES]).default('ALL'),
  sort: z.enum(SELLER_PRODUCT_SORTS).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
});

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true } },
  images: { orderBy: { sortOrder: 'asc' }, take: 1 },
  variants: {
    orderBy: { createdAt: 'asc' },
    select: { sku: true, stock: true, pricePaise: true, mrpPaise: true },
  },
} satisfies Prisma.ProductInclude;

type ProductRecord = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

/** What a shopper sees for this listing today. */
function listingStateOf(product: ProductRecord, totalStock: number): ListingState {
  if (product.status === 'DRAFT') return 'DRAFT';
  if (product.status === 'PENDING') return 'PENDING';
  if (product.status === 'REJECTED') return 'REJECTED';
  if (!product.isVisible) return 'INACTIVE';
  if (totalStock <= 0 && !product.allowBackorders) return 'OUT_OF_STOCK';
  return 'ACTIVE';
}

interface SalesRow {
  unitsSold: number;
  salesPaise: number;
}

/** Units and revenue per product, over lines that actually count as sales. */
async function salesByProduct(sellerId: string): Promise<Map<string, SalesRow>> {
  const items = await prisma.orderItem.findMany({
    where: { sellerId, status: { notIn: ['PLACED', 'CANCELLED', 'RETURNED'] } },
    select: { productId: true, quantity: true, pricePaise: true },
  });
  const map = new Map<string, SalesRow>();
  for (const item of items) {
    const row = map.get(item.productId) ?? { unitsSold: 0, salesPaise: 0 };
    row.unitsSold += item.quantity;
    row.salesPaise += item.pricePaise * item.quantity;
    map.set(item.productId, row);
  }
  return map;
}

function toRow(product: ProductRecord, sales: SalesRow | undefined): SellerProductRow {
  const totalStock = product.variants.reduce((sum, v) => sum + v.stock, 0);
  const cheapest = product.variants.reduce<(typeof product.variants)[number] | null>(
    (min, v) => (!min || v.pricePaise < min.pricePaise ? v : min),
    null,
  );
  return {
    id: product.id,
    title: product.title,
    slug: product.slug,
    brand: product.brand,
    shortDescription: product.shortDescription,
    imageUrl: product.images[0]?.url ?? null,
    categoryId: product.category.id,
    categoryName: product.category.name,
    sku: product.variants[0]?.sku ?? '—',
    variantCount: product.variants.length,
    totalStock,
    lowStockAlert: product.lowStockAlert,
    pricePaise: cheapest?.pricePaise ?? product.basePricePaise,
    mrpPaise: cheapest?.mrpPaise ?? null,
    status: product.status,
    rejectionReason: product.rejectionReason,
    listingState: listingStateOf(product, totalStock),
    isVisible: product.isVisible,
    views: product.viewCount,
    unitsSold: sales?.unitsSold ?? 0,
    salesPaise: sales?.salesPaise ?? 0,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

function compare(a: SellerProductRow, b: SellerProductRow, sort: SellerProductSort): number {
  switch (sort) {
    case 'OLDEST':
      return a.createdAt.localeCompare(b.createdAt);
    case 'PRICE_HIGH':
      return b.pricePaise - a.pricePaise;
    case 'PRICE_LOW':
      return a.pricePaise - b.pricePaise;
    case 'SALES':
      return b.salesPaise - a.salesPaise;
    case 'VIEWS':
      return b.views - a.views;
    case 'STOCK_LOW':
      return a.totalStock - b.totalStock;
    default:
      return b.createdAt.localeCompare(a.createdAt);
  }
}

async function loadRows(
  sellerId: string,
  query: z.infer<typeof listQuery>,
): Promise<SellerProductRow[]> {
  const where: Prisma.ProductWhereInput = {
    sellerId,
    status: { not: 'ARCHIVED' },
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: 'insensitive' } },
            { brand: { contains: query.q, mode: 'insensitive' } },
            { category: { name: { contains: query.q, mode: 'insensitive' } } },
            { variants: { some: { sku: { contains: query.q, mode: 'insensitive' } } } },
            { tags: { has: query.q.toLowerCase() } },
          ],
        }
      : {}),
  };

  const [products, sales] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
      include: PRODUCT_INCLUDE,
    }),
    salesByProduct(sellerId),
  ]);

  // Listing state mixes status, visibility and stock, so it is filtered here.
  return products
    .map((p) => toRow(p, sales.get(p.id)))
    .filter((row) => query.state === 'ALL' || row.listingState === query.state)
    .sort((a, b) => compare(a, b, query.sort));
}

// ---------------------------------------------------------------------------
// GET / — the products table
// ---------------------------------------------------------------------------

sellerProductsRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const rows = await loadRows(req.seller!.id, query);
    const body: SellerProductPage = {
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
// GET /summary — catalogue KPIs, status split, top performers
// ---------------------------------------------------------------------------

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

sellerProductsRouter.get('/summary', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const now = new Date();
    const windowStart = new Date(now.getTime() - VIEW_WINDOW_DAYS * 86400000);
    const previousStart = new Date(now.getTime() - 2 * VIEW_WINDOW_DAYS * 86400000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [rows, views30d, viewsPrev30d, newThisMonth, newPrevMonth, soldItems] = await Promise.all([
      loadRows(sellerId, listQuery.parse({})),
      prisma.productView.count({
        where: { product: { sellerId }, createdAt: { gte: windowStart } },
      }),
      prisma.productView.count({
        where: { product: { sellerId }, createdAt: { gte: previousStart, lt: windowStart } },
      }),
      prisma.product.count({
        where: { sellerId, status: { not: 'ARCHIVED' }, createdAt: { gte: monthStart } },
      }),
      prisma.product.count({
        where: {
          sellerId,
          status: { not: 'ARCHIVED' },
          createdAt: { gte: prevMonthStart, lt: monthStart },
        },
      }),
      prisma.orderItem.findMany({
        where: {
          sellerId,
          status: { notIn: ['PLACED', 'CANCELLED', 'RETURNED'] },
          order: { createdAt: { gte: prevMonthStart } },
        },
        select: { pricePaise: true, quantity: true, order: { select: { createdAt: true } } },
      }),
    ]);

    const salesIn = (from: Date, to?: Date) =>
      soldItems
        .filter((i) => i.order.createdAt >= from && (!to || i.order.createdAt < to))
        .reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
    const salesThisMonth = salesIn(monthStart);
    const salesPrevMonth = salesIn(prevMonthStart, monthStart);

    const counts = new Map<ListingState, number>();
    for (const row of rows) {
      counts.set(row.listingState, (counts.get(row.listingState) ?? 0) + 1);
    }

    const categories = new Map<string, { name: string; count: number }>();
    for (const row of rows) {
      const entry = categories.get(row.categoryId) ?? { name: row.categoryName, count: 0 };
      entry.count += 1;
      categories.set(row.categoryId, entry);
    }

    const body: SellerCatalogSummary = {
      kpis: {
        total: rows.length,
        totalChangePercent: changePercent(newThisMonth, newPrevMonth),
        active: counts.get('ACTIVE') ?? 0,
        outOfStock: counts.get('OUT_OF_STOCK') ?? 0,
        lowStock: rows.filter(
          (r) => r.totalStock > 0 && r.totalStock <= r.lowStockAlert,
        ).length,
        views30d,
        viewsChangePercent: changePercent(views30d, viewsPrev30d),
        salesPaise: rows.reduce((sum, r) => sum + r.salesPaise, 0),
        salesChangePercent: changePercent(salesThisMonth, salesPrevMonth),
      },
      statusBreakdown: LISTING_STATES.map((state) => ({
        key: state,
        label: LISTING_STATE_LABELS[state],
        count: counts.get(state) ?? 0,
        share: rows.length > 0 ? Math.round(((counts.get(state) ?? 0) / rows.length) * 1000) / 10 : 0,
      })).filter((s) => s.count > 0),
      topProducts: [...rows]
        .sort((a, b) => b.salesPaise - a.salesPaise)
        .slice(0, 5)
        .filter((r) => r.unitsSold > 0)
        .map((r) => ({
          id: r.id,
          title: r.title,
          slug: r.slug,
          imageUrl: r.imageUrl,
          unitsSold: r.unitsSold,
          salesPaise: r.salesPaise,
          pricePaise: r.pricePaise,
        })),
      categories: [...categories.entries()]
        .map(([id, c]) => ({ id, name: c.name, count: c.count }))
        .sort((a, b) => b.count - a.count),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /export — the filtered catalogue as CSV
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

sellerProductsRouter.get('/export', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const rows = await loadRows(req.seller!.id, query);

    const header = [
      'Product',
      'SKU',
      'Brand',
      'Category',
      'Price (INR)',
      'MRP (INR)',
      'Stock',
      'Variants',
      'State',
      'Approval status',
      'Views',
      'Units sold',
      'Sales (INR)',
      'Updated',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.title,
          row.sku,
          row.brand ?? '',
          row.categoryName,
          (row.pricePaise / 100).toFixed(2),
          row.mrpPaise != null ? (row.mrpPaise / 100).toFixed(2) : '',
          row.totalStock,
          row.variantCount,
          row.listingState,
          row.status,
          row.views,
          row.unitsSold,
          (row.salesPaise / 100).toFixed(2),
          row.updatedAt,
        ]
          .map(csvCell)
          .join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clowe-products.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id/visibility — the Active/Inactive switch on a row
// ---------------------------------------------------------------------------

sellerProductsRouter.patch('/:id/visibility', async (req, res, next) => {
  try {
    const { isVisible } = z.object({ isVisible: z.boolean() }).parse(req.body);
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, sellerId: req.seller!.id },
      include: PRODUCT_INCLUDE,
    });
    if (!product) throw ApiError.notFound('Product not found');

    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { isVisible },
      include: PRODUCT_INCLUDE,
    });
    const sales = await salesByProduct(req.seller!.id);
    res.json({ success: true, data: toRow(updated, sales.get(updated.id)) });
  } catch (err) {
    next(err);
  }
});
