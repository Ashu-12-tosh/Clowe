import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  INVENTORY_SORTS,
  STOCK_STATES,
  STOCK_STATE_LABELS,
  stockBulkSchema,
  type InventoryPage,
  type InventoryRow,
  type InventorySort,
  type InventorySummary,
  type StockState,
  type StockUpdateResult,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { ensureDefaultWarehouse, setVariantTotal } from '../services/stockService';
import { requireSeller } from './seller';

export const sellerInventoryRouter = Router();
sellerInventoryRouter.use(requireAuth, requireSeller);

const SCAN_CAP = 5000;
const VIEW_WINDOW_DAYS = 30;

const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  categoryId: z.string().trim().optional(),
  state: z.enum(['ALL', ...STOCK_STATES]).default('ALL'),
  sort: z.enum(INVENTORY_SORTS).default('STOCK_LOW'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(20),
});

const VARIANT_INCLUDE = {
  product: {
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      isVisible: true,
      lowStockAlert: true,
      allowBackorders: true,
      updatedAt: true,
      category: { select: { id: true, name: true } },
      images: { orderBy: { sortOrder: 'asc' }, take: 1 },
    },
  },
} satisfies Prisma.ProductVariantInclude;

type VariantRecord = Prisma.ProductVariantGetPayload<{ include: typeof VARIANT_INCLUDE }>;

function stockStateOf(stock: number, lowStockAlert: number): StockState {
  if (stock <= 0) return 'OUT_OF_STOCK';
  if (stock <= lowStockAlert) return 'LOW_STOCK';
  return 'IN_STOCK';
}

/** Units sold and units committed to orders that haven't shipped, per variant. */
async function movementByVariant(
  sellerId: string,
): Promise<Map<string, { unitsSold: number; reserved: number }>> {
  const items = await prisma.orderItem.findMany({
    where: { sellerId, order: { status: { not: 'PLACED' } } },
    select: { variantId: true, quantity: true, status: true },
  });
  const map = new Map<string, { unitsSold: number; reserved: number }>();
  for (const item of items) {
    const entry = map.get(item.variantId) ?? { unitsSold: 0, reserved: 0 };
    if (!['CANCELLED', 'RETURNED'].includes(item.status)) entry.unitsSold += item.quantity;
    // Paid but not yet handed to a courier — the stock is spoken for.
    if (['CONFIRMED', 'PACKED'].includes(item.status)) entry.reserved += item.quantity;
    map.set(item.variantId, entry);
  }
  return map;
}

function toRow(
  variant: VariantRecord,
  movement: { unitsSold: number; reserved: number } | undefined,
): InventoryRow {
  const product = variant.product;
  const state = stockStateOf(variant.stock, product.lowStockAlert);
  return {
    variantId: variant.id,
    productId: product.id,
    title: product.title,
    slug: product.slug,
    imageUrl: product.images[0]?.url ?? null,
    categoryName: product.category.name,
    sku: variant.sku,
    size: variant.size,
    color: variant.color,
    label: variant.label,
    pricePaise: variant.pricePaise,
    mrpPaise: variant.mrpPaise,
    stock: variant.stock,
    lowStockAlert: product.lowStockAlert,
    stockState: state,
    stockStateLabel: STOCK_STATE_LABELS[state],
    stockValuePaise: variant.stock * variant.pricePaise,
    allowBackorders: product.allowBackorders,
    unitsSold: movement?.unitsSold ?? 0,
    reservedUnits: movement?.reserved ?? 0,
    productStatus: product.status,
    isVisible: product.isVisible,
    updatedAt: product.updatedAt.toISOString(),
  };
}

function compare(a: InventoryRow, b: InventoryRow, sort: InventorySort): number {
  switch (sort) {
    case 'STOCK_HIGH':
      return b.stock - a.stock;
    case 'UPDATED':
      return b.updatedAt.localeCompare(a.updatedAt);
    case 'SALES':
      return b.unitsSold - a.unitsSold;
    case 'VALUE_HIGH':
      return b.stockValuePaise - a.stockValuePaise;
    default:
      return a.stock - b.stock;
  }
}

async function loadRows(
  sellerId: string,
  query: z.infer<typeof listQuery>,
): Promise<InventoryRow[]> {
  const where: Prisma.ProductVariantWhereInput = {
    product: {
      sellerId,
      status: { not: 'ARCHIVED' },
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    },
    ...(query.q
      ? {
          OR: [
            { sku: { contains: query.q, mode: 'insensitive' } },
            { label: { contains: query.q, mode: 'insensitive' } },
            { product: { sellerId, title: { contains: query.q, mode: 'insensitive' } } },
            {
              product: {
                sellerId,
                category: { name: { contains: query.q, mode: 'insensitive' } },
              },
            },
          ],
        }
      : {}),
  };

  const [variants, movement] = await Promise.all([
    prisma.productVariant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
      include: VARIANT_INCLUDE,
    }),
    movementByVariant(sellerId),
  ]);

  return variants
    .map((v) => toRow(v, movement.get(v.id)))
    .filter((row) => query.state === 'ALL' || row.stockState === query.state)
    .sort((a, b) => compare(a, b, query.sort));
}

// ---------------------------------------------------------------------------
// GET / — the inventory table
// ---------------------------------------------------------------------------

sellerInventoryRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const rows = await loadRows(req.seller!.id, query);
    const body: InventoryPage = {
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
// GET /summary — stock health, restock list, performance
// ---------------------------------------------------------------------------

sellerInventoryRouter.get('/summary', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const windowStart = new Date(Date.now() - VIEW_WINDOW_DAYS * 86400000);

    const [rows, views30d, recentItems] = await Promise.all([
      loadRows(sellerId, listQuery.parse({})),
      prisma.productView.count({
        where: { product: { sellerId }, createdAt: { gte: windowStart } },
      }),
      prisma.orderItem.findMany({
        where: {
          sellerId,
          status: { notIn: ['PLACED', 'CANCELLED', 'RETURNED'] },
          order: { createdAt: { gte: windowStart } },
        },
        select: { quantity: true, pricePaise: true, orderId: true },
      }),
    ]);

    const counts = new Map<StockState, number>();
    for (const row of rows) counts.set(row.stockState, (counts.get(row.stockState) ?? 0) + 1);

    const productIds = new Set(rows.map((r) => r.productId));
    const unitsSold30d = recentItems.reduce((sum, i) => sum + i.quantity, 0);
    const revenue30d = recentItems.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
    const orders30d = new Set(recentItems.map((i) => i.orderId)).size;

    // Best sellers, rolled up from variants to their product.
    const byProduct = new Map<
      string,
      { title: string; imageUrl: string | null; unitsSold: number; salesPaise: number; stock: number }
    >();
    for (const row of rows) {
      const entry = byProduct.get(row.productId) ?? {
        title: row.title,
        imageUrl: row.imageUrl,
        unitsSold: 0,
        salesPaise: 0,
        stock: 0,
      };
      entry.unitsSold += row.unitsSold;
      entry.salesPaise += row.unitsSold * row.pricePaise;
      entry.stock += row.stock;
      byProduct.set(row.productId, entry);
    }

    const categories = new Map<string, { name: string; count: number }>();
    for (const row of rows) {
      const key = row.categoryName;
      const entry = categories.get(key) ?? { name: key, count: 0 };
      entry.count += 1;
      categories.set(key, entry);
    }

    const body: InventorySummary = {
      kpis: {
        variants: rows.length,
        products: productIds.size,
        inStock: counts.get('IN_STOCK') ?? 0,
        lowStock: counts.get('LOW_STOCK') ?? 0,
        outOfStock: counts.get('OUT_OF_STOCK') ?? 0,
        totalUnits: rows.reduce((sum, r) => sum + r.stock, 0),
        stockValuePaise: rows.reduce((sum, r) => sum + r.stockValuePaise, 0),
        reservedUnits: rows.reduce((sum, r) => sum + r.reservedUnits, 0),
      },
      stockBreakdown: STOCK_STATES.map((key) => ({
        key,
        label: STOCK_STATE_LABELS[key],
        count: counts.get(key) ?? 0,
        share: rows.length > 0 ? Math.round(((counts.get(key) ?? 0) / rows.length) * 1000) / 10 : 0,
      })).filter((s) => s.count > 0),
      // Out of stock first, then whatever is closest to running out.
      restockList: rows
        .filter((r) => r.stockState !== 'IN_STOCK')
        .sort((a, b) => a.stock - b.stock || b.unitsSold - a.unitsSold)
        .slice(0, 10)
        .map((r) => ({
          variantId: r.variantId,
          productId: r.productId,
          title: r.title,
          sku: r.sku,
          size: r.size,
          color: r.color,
          label: r.label,
          stock: r.stock,
          lowStockAlert: r.lowStockAlert,
          unitsSold: r.unitsSold,
        })),
      topSellers: [...byProduct.entries()]
        .map(([productId, v]) => ({ productId, ...v }))
        .filter((p) => p.unitsSold > 0)
        .sort((a, b) => b.salesPaise - a.salesPaise)
        .slice(0, 5),
      performance: {
        views30d,
        unitsSold30d,
        conversionRate: views30d > 0 ? Math.round((orders30d / views30d) * 1000) / 10 : 0,
        avgOrderValuePaise: orders30d > 0 ? Math.round(revenue30d / orders30d) : 0,
      },
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
// PATCH /stock — set or adjust stock on one or many variants
// ---------------------------------------------------------------------------

sellerInventoryRouter.patch('/stock', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const input = stockBulkSchema.parse(req.body);

    const ids = input.updates.map((u) => u.variantId);
    const owned = await prisma.productVariant.findMany({
      where: { id: { in: ids }, product: { sellerId } },
      select: { id: true, stock: true },
    });
    const stockById = new Map(owned.map((v) => [v.id, v.stock]));

    const skipped: { variantId: string; reason: string }[] = [];
    let updated = 0;
    const warehouse = await ensureDefaultWarehouse();

    for (const update of input.updates) {
      const current = stockById.get(update.variantId);
      if (current === undefined) {
        skipped.push({ variantId: update.variantId, reason: 'Not one of your variants' });
        continue;
      }
      if (update.stock === undefined && update.delta === undefined) {
        skipped.push({ variantId: update.variantId, reason: 'No new stock value given' });
        continue;
      }
      // A relative adjustment can never push stock below zero.
      const next =
        update.stock !== undefined ? update.stock : Math.max(0, current + (update.delta ?? 0));
      // Goes through the stock service so the warehouse rows and the movement
      // ledger stay true — a seller edit is an adjustment like any other.
      await prisma.$transaction((tx) =>
        setVariantTotal(tx, {
          variantId: update.variantId,
          newTotal: next,
          defaultWarehouseId: warehouse.id,
          reason: 'Seller stock update',
          actorId: req.auth!.userId,
        }),
      );
      updated += 1;
    }

    // Return the fresh rows so the table reflects the new state immediately.
    const refreshed = await prisma.productVariant.findMany({
      where: { id: { in: ids }, product: { sellerId } },
      include: VARIANT_INCLUDE,
    });
    const movement = await movementByVariant(sellerId);
    const body: StockUpdateResult = {
      updated,
      skipped,
      rows: refreshed.map((v) => toRow(v, movement.get(v.id))),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /products/:id/threshold — the low-stock alert level
// ---------------------------------------------------------------------------

sellerInventoryRouter.patch('/products/:id/threshold', async (req, res, next) => {
  try {
    const { lowStockAlert } = z
      .object({ lowStockAlert: z.number().int().min(0).max(1000) })
      .parse(req.body);
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, sellerId: req.seller!.id },
      select: { id: true },
    });
    if (!product) throw ApiError.notFound('Product not found');

    await prisma.product.update({ where: { id: product.id }, data: { lowStockAlert } });
    res.json({ success: true, data: { id: product.id, lowStockAlert } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /export — the filtered inventory as CSV
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

sellerInventoryRouter.get('/export', async (req, res, next) => {
  try {
    const rows = await loadRows(req.seller!.id, listQuery.parse(req.query));
    const header = [
      'SKU',
      'Product',
      'Category',
      'Variant',
      'Stock',
      'Low stock alert',
      'Stock state',
      'Price (INR)',
      'Stock value (INR)',
      'Units sold',
      'Reserved',
      'Product status',
      'Visible',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.sku,
          row.title,
          row.categoryName,
          row.label,
          row.stock,
          row.lowStockAlert,
          row.stockState,
          (row.pricePaise / 100).toFixed(2),
          (row.stockValuePaise / 100).toFixed(2),
          row.unitsSold,
          row.reservedUnits,
          row.productStatus,
          row.isVisible ? 'YES' : 'NO',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clowe-inventory.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});
