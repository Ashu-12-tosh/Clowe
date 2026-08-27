import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  INVENTORY_SORT_OPTIONS,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABELS,
  OVERSTOCK_MULTIPLE,
  PO_STATUS_LABELS,
  STOCK_STATUSES,
  STOCK_STATUS_LABELS,
  TRANSFER_STATUS_LABELS,
  directReceiptSchema,
  inventoryBulkSchema,
  inventoryImportSchema,
  purchaseOrderSchema,
  receivePurchaseOrderSchema,
  reorderLevelSchema,
  stockAdjustmentSchema,
  supplierSchema,
  transferSchema,
  transferStatusSchema,
  warehouseSchema,
  type AdminInventorySummary,
  type InventoryBulkResult,
  type InventoryFilterOptions,
  type InventoryImportResult,
  type InventoryStockPage,
  type InventoryStockRow,
  type MovementPage,
  type MovementRow,
  type PoStatus,
  type PurchaseOrderRow,
  type StockStatusValue,
  type SupplierRow,
  type TransferRow,
  type TransferStatus,
  type WarehouseRow,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import {
  adjustStock,
  moveBetweenWarehouses,
  nextDocumentNumber,
  receiveStock,
} from '../services/stockService';

export const adminInventoryRouter = Router();
adminInventoryRouter.use(requireAuth, requireRole('ADMIN'));

/** Locations scanned per request — a hard ceiling so one call can't sit on the DB. */
const SCAN_CAP = 20000;
const TREND_DAYS = 30;

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

const LOCATION_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true, isActive: true } },
  variant: {
    select: {
      id: true,
      sku: true,
      size: true,
      color: true,
      pricePaise: true,
      product: {
        select: {
          id: true,
          title: true,
          status: true,
          categoryId: true,
          brandId: true,
          sellerId: true,
          category: { select: { id: true, name: true } },
          brandRef: { select: { id: true, name: true } },
          seller: { select: { id: true, shopName: true } },
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
        },
      },
    },
  },
} satisfies Prisma.StockLocationInclude;

type LocationRecord = Prisma.StockLocationGetPayload<{ include: typeof LOCATION_INCLUDE }>;

function statusOf(available: number, reorderLevel: number): StockStatusValue {
  if (available <= 0) return 'OUT_OF_STOCK';
  if (available <= reorderLevel) return 'LOW_STOCK';
  if (reorderLevel > 0 && available >= reorderLevel * OVERSTOCK_MULTIPLE) return 'OVERSTOCK';
  return 'IN_STOCK';
}

/** Units committed to orders that are paid but not yet with a courier. */
async function reservedByVariant(): Promise<Map<string, number>> {
  const items = await prisma.orderItem.groupBy({
    by: ['variantId'],
    where: { status: { in: ['CONFIRMED', 'PACKED'] } },
    _sum: { quantity: true },
  });
  return new Map(items.map((i) => [i.variantId, i._sum.quantity ?? 0]));
}

/** Units on an open purchase order or an in-flight transfer, per variant. */
async function incomingByVariant(): Promise<Map<string, number>> {
  const [poLines, transferLines] = await Promise.all([
    prisma.purchaseOrderItem.findMany({
      where: { purchaseOrder: { status: { in: ['ORDERED', 'PARTIAL'] } } },
      select: { variantId: true, quantityOrdered: true, quantityReceived: true },
    }),
    prisma.stockTransferItem.findMany({
      where: { transfer: { status: 'IN_TRANSIT' } },
      select: { variantId: true, quantity: true },
    }),
  ]);
  const map = new Map<string, number>();
  for (const line of poLines) {
    const outstanding = Math.max(0, line.quantityOrdered - line.quantityReceived);
    if (outstanding > 0) map.set(line.variantId, (map.get(line.variantId) ?? 0) + outstanding);
  }
  for (const line of transferLines) {
    map.set(line.variantId, (map.get(line.variantId) ?? 0) + line.quantity);
  }
  return map;
}

function toStockRow(
  location: LocationRecord,
  reserved: number,
  incoming: number,
  lastMovementAt: Date | undefined,
): InventoryStockRow {
  const variant = location.variant;
  const product = variant.product;
  const status = statusOf(location.quantity, location.reorderLevel);
  return {
    locationId: location.id,
    variantId: variant.id,
    productId: product.id,
    sku: variant.sku,
    title: product.title,
    imageUrl: product.images[0]?.url ?? null,
    categoryName: product.category.name,
    brandName: product.brandRef?.name ?? null,
    sellerName: product.seller.shopName,
    size: variant.size,
    color: variant.color,
    warehouseId: location.warehouse.id,
    warehouseName: location.warehouse.name,
    warehouseCode: location.warehouse.code,
    available: location.quantity,
    reserved,
    incoming,
    reorderLevel: location.reorderLevel,
    status,
    statusLabel: STOCK_STATUS_LABELS[status],
    unitPricePaise: variant.pricePaise,
    stockValuePaise: location.quantity * variant.pricePaise,
    lastMovementAt: lastMovementAt?.toISOString() ?? null,
    updatedAt: location.updatedAt.toISOString(),
  };
}

const stockQuery = z.object({
  q: z.string().trim().max(80).optional(),
  warehouseId: z.string().trim().optional(),
  categoryId: z.string().trim().optional(),
  brandId: z.string().trim().optional(),
  sellerId: z.string().trim().optional(),
  status: z.enum(['ALL', ...STOCK_STATUSES]).default('ALL'),
  sort: z.enum(INVENTORY_SORT_OPTIONS).default('STOCK_LOW'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(10),
});

type StockQuery = z.infer<typeof stockQuery>;

/**
 * Everything the overview table needs. Filtering that Postgres can do happens
 * in the query; status is derived per row, so it is applied after loading.
 */
async function loadStockRows(query: StockQuery): Promise<InventoryStockRow[]> {
  const where: Prisma.StockLocationWhereInput = {
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
    variant: {
      product: {
        status: { not: 'ARCHIVED' },
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.brandId ? { brandId: query.brandId } : {}),
        ...(query.sellerId ? { sellerId: query.sellerId } : {}),
      },
      ...(query.q
        ? {
            OR: [
              { sku: { contains: query.q, mode: 'insensitive' } },
              { product: { title: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
  };

  const [locations, reserved, incoming] = await Promise.all([
    prisma.stockLocation.findMany({ where, include: LOCATION_INCLUDE, take: SCAN_CAP }),
    reservedByVariant(),
    incomingByVariant(),
  ]);

  // Last movement per variant, for the "Last Updated" column.
  const variantIds = [...new Set(locations.map((l) => l.variantId))];
  const lastMovements = await prisma.stockMovement.groupBy({
    by: ['variantId'],
    where: { variantId: { in: variantIds } },
    _max: { createdAt: true },
  });
  const lastByVariant = new Map(
    lastMovements.map((m) => [m.variantId, m._max.createdAt ?? undefined]),
  );

  const rows = locations.map((location) =>
    toStockRow(
      location,
      reserved.get(location.variantId) ?? 0,
      incoming.get(location.variantId) ?? 0,
      lastByVariant.get(location.variantId),
    ),
  );

  const filtered = rows.filter((row) => query.status === 'ALL' || row.status === query.status);
  filtered.sort((a, b) => {
    switch (query.sort) {
      case 'STOCK_HIGH':
        return b.available - a.available;
      case 'VALUE_HIGH':
        return b.stockValuePaise - a.stockValuePaise;
      case 'UPDATED':
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      case 'SKU':
        return a.sku.localeCompare(b.sku);
      default:
        return a.available - b.available;
    }
  });
  return filtered;
}

// ---------------------------------------------------------------------------
// GET /stock — the paged overview table
// ---------------------------------------------------------------------------

adminInventoryRouter.get('/stock', async (req, res, next) => {
  try {
    const query = stockQuery.parse(req.query);
    const all = await loadStockRows(query);
    const start = (query.page - 1) * query.pageSize;
    const body: InventoryStockPage = {
      rows: all.slice(start, start + query.pageSize),
      total: all.length,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(all.length / query.pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /summary — KPIs, warehouse split, alerts, accuracy, trend
// ---------------------------------------------------------------------------

adminInventoryRouter.get('/summary', async (req, res, next) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const trendFrom = new Date(startOfToday.getTime() - (TREND_DAYS - 1) * 86400000);

    const [locations, warehouses, monthMovements, recentMovements, transfers, poLines] =
      await Promise.all([
        prisma.stockLocation.findMany({
          where: { variant: { product: { status: { not: 'ARCHIVED' } } } },
          include: {
            warehouse: { select: { id: true, code: true, name: true, isActive: true } },
            variant: {
              select: {
                id: true,
                sku: true,
                pricePaise: true,
                product: {
                  select: { title: true, category: { select: { id: true, name: true } } },
                },
              },
            },
          },
          take: SCAN_CAP,
        }),
        prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true } }),
        prisma.stockMovement.findMany({
          where: { createdAt: { gte: startOfMonth } },
          select: { type: true, quantity: true, createdAt: true },
        }),
        prisma.stockMovement.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
          include: {
            variant: { select: { sku: true, product: { select: { title: true } } } },
            fromWarehouse: { select: { name: true } },
            toWarehouse: { select: { name: true } },
            actor: { select: { name: true } },
          },
        }),
        prisma.stockTransfer.findMany({
          where: { status: { in: ['PENDING', 'IN_TRANSIT'] } },
          select: { status: true, items: { select: { quantity: true } } },
        }),
        prisma.purchaseOrderItem.findMany({
          where: { purchaseOrder: { status: { in: ['ORDERED', 'PARTIAL'] } } },
          select: { quantityOrdered: true, quantityReceived: true },
        }),
      ]);

    // --- KPIs -------------------------------------------------------------
    const skus = new Set<string>();
    let totalUnits = 0;
    let inventoryValuePaise = 0;
    let lowStockItems = 0;
    let outOfStockItems = 0;
    let overstockItems = 0;
    const statusCounts = new Map<StockStatusValue, number>();
    const byWarehouse = new Map<
      string,
      { code: string; name: string; valuePaise: number; units: number }
    >();
    const byCategory = new Map<string, { name: string; valuePaise: number; units: number }>();

    for (const location of locations) {
      skus.add(location.variantId);
      totalUnits += location.quantity;
      const value = location.quantity * location.variant.pricePaise;
      inventoryValuePaise += value;

      const status = statusOf(location.quantity, location.reorderLevel);
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
      if (status === 'LOW_STOCK') lowStockItems += 1;
      if (status === 'OUT_OF_STOCK') outOfStockItems += 1;
      if (status === 'OVERSTOCK') overstockItems += 1;

      const w = byWarehouse.get(location.warehouse.id) ?? {
        code: location.warehouse.code,
        name: location.warehouse.name,
        valuePaise: 0,
        units: 0,
      };
      w.valuePaise += value;
      w.units += location.quantity;
      byWarehouse.set(location.warehouse.id, w);

      const cat = location.variant.product.category;
      const c = byCategory.get(cat.id) ?? { name: cat.name, valuePaise: 0, units: 0 };
      c.valuePaise += value;
      c.units += location.quantity;
      byCategory.set(cat.id, c);
    }

    // --- Stock accuracy ---------------------------------------------------
    const counted = locations.filter((l) => l.lastCountedAt !== null);
    const matched = counted.filter((l) => l.lastCountMatched === true).length;
    const mismatched = counted.length - matched;
    const accuracyPercent =
      counted.length > 0 ? Math.round((matched / counted.length) * 1000) / 10 : null;

    // --- Movement totals --------------------------------------------------
    const totals = { receipts: 0, dispatch: 0, transfers: 0, adjustments: 0 };
    for (const m of monthMovements) {
      if (m.type === 'RECEIPT') totals.receipts += m.quantity;
      else if (m.type === 'DISPATCH') totals.dispatch += m.quantity;
      else if (m.type === 'TRANSFER') totals.transfers += m.quantity;
      else if (m.type === 'ADJUSTMENT' || m.type === 'RETURN') totals.adjustments += m.quantity;
    }

    const receiptsToday = monthMovements
      .filter((m) => m.type === 'RECEIPT' && m.createdAt >= startOfToday)
      .reduce((sum, m) => sum + m.quantity, 0);
    const dispatchToday = monthMovements
      .filter((m) => m.type === 'DISPATCH' && m.createdAt >= startOfToday)
      .reduce((sum, m) => sum + m.quantity, 0);

    // --- In transit -------------------------------------------------------
    const transferUnitsInFlight = transfers
      .filter((t) => t.status === 'IN_TRANSIT')
      .reduce((sum, t) => sum + t.items.reduce((s, i) => s + i.quantity, 0), 0);
    const poUnitsOutstanding = poLines.reduce(
      (sum, l) => sum + Math.max(0, l.quantityOrdered - l.quantityReceived),
      0,
    );
    const pendingTransfers = transfers
      .filter((t) => t.status === 'PENDING')
      .reduce((sum, t) => sum + t.items.reduce((s, i) => s + i.quantity, 0), 0);

    // --- Value trend ------------------------------------------------------
    // Today's value is known; walking the ledger backwards day by day gives the
    // value on every earlier day without storing a snapshot.
    const trendMovements = await prisma.stockMovement.findMany({
      where: { createdAt: { gte: trendFrom }, type: { not: 'TRANSFER' } },
      select: { type: true, quantity: true, createdAt: true, variantId: true },
    });
    const priceByVariant = new Map(locations.map((l) => [l.variantId, l.variant.pricePaise]));
    const deltaByDay = new Map<string, number>();
    for (const m of trendMovements) {
      const price = priceByVariant.get(m.variantId) ?? 0;
      const signed =
        m.type === 'DISPATCH'
          ? -m.quantity * price
          : m.type === 'ADJUSTMENT'
            ? 0 // sign is not recoverable from the row alone; handled below
            : m.quantity * price;
      const key = dayKey(m.createdAt);
      deltaByDay.set(key, (deltaByDay.get(key) ?? 0) + signed);
    }
    // Adjustments carry their direction in the warehouse columns.
    const adjustments = await prisma.stockMovement.findMany({
      where: { createdAt: { gte: trendFrom }, type: 'ADJUSTMENT' },
      select: { quantity: true, createdAt: true, variantId: true, toWarehouseId: true },
    });
    for (const m of adjustments) {
      const price = priceByVariant.get(m.variantId) ?? 0;
      const signed = (m.toWarehouseId ? 1 : -1) * m.quantity * price;
      const key = dayKey(m.createdAt);
      deltaByDay.set(key, (deltaByDay.get(key) ?? 0) + signed);
    }

    const valueTrend: { date: string; valuePaise: number }[] = [];
    let running = inventoryValuePaise;
    for (let i = 0; i < TREND_DAYS; i += 1) {
      const day = new Date(startOfToday.getTime() - i * 86400000);
      const key = dayKey(day);
      valueTrend.unshift({ date: key, valuePaise: Math.max(0, running) });
      running -= deltaByDay.get(key) ?? 0;
    }

    // --- Low stock alerts -------------------------------------------------
    const lowStockAlerts = locations
      .filter((l) => l.quantity <= l.reorderLevel)
      .sort((a, b) => a.quantity - b.quantity)
      .slice(0, 8)
      .map((l) => ({
        locationId: l.id,
        variantId: l.variantId,
        sku: l.variant.sku,
        title: l.variant.product.title,
        warehouseName: l.warehouse.name,
        available: l.quantity,
        reorderLevel: l.reorderLevel,
      }));

    const totalLocations = locations.length || 1;
    const categoryTotal = [...byCategory.values()].reduce((s, c) => s + c.valuePaise, 0) || 1;
    const warehouseTotal = inventoryValuePaise || 1;

    const body: AdminInventorySummary = {
      kpis: {
        totalSkus: skus.size,
        totalUnits,
        inventoryValuePaise,
        lowStockItems,
        outOfStockItems,
        overstockItems,
        stockAccuracyPercent: accuracyPercent,
        countedLocations: counted.length,
      },
      strip: {
        activeWarehouses: warehouses.length,
        unitsInTransit: transferUnitsInFlight + poUnitsOutstanding,
        receiptsToday,
        dispatchToday,
        pendingTransfers,
      },
      valueByWarehouse: [...byWarehouse.entries()]
        .map(([id, w]) => ({
          id,
          code: w.code,
          name: w.name,
          valuePaise: w.valuePaise,
          units: w.units,
          share: Math.round((w.valuePaise / warehouseTotal) * 1000) / 10,
        }))
        .sort((a, b) => b.valuePaise - a.valuePaise),
      statusBreakdown: STOCK_STATUSES.map((key) => {
        const count = statusCounts.get(key) ?? 0;
        return {
          key,
          label: STOCK_STATUS_LABELS[key],
          count,
          share: Math.round((count / totalLocations) * 1000) / 10,
        };
      }).filter((s) => s.count > 0),
      lowStockAlerts,
      accuracy: {
        matched,
        mismatched,
        notCounted: locations.length - counted.length,
        accuracyPercent,
      },
      recentMovements: recentMovements.map(toMovementRow),
      movementTotals: totals,
      valueTrend,
      topCategories: [...byCategory.entries()]
        .map(([id, c]) => ({
          id,
          name: c.name,
          valuePaise: c.valuePaise,
          units: c.units,
          share: Math.round((c.valuePaise / categoryTotal) * 1000) / 10,
        }))
        .sort((a, b) => b.valuePaise - a.valuePaise)
        .slice(0, 6),
      insights: buildInsights({
        lowStockItems,
        outOfStockItems,
        overstockItems,
        poUnitsOutstanding,
        pendingTransfers,
        notCounted: locations.length - counted.length,
        totalLocations: locations.length,
      }),
    };

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Plain-language read of the numbers above — no model call, just thresholds. */
function buildInsights(input: {
  lowStockItems: number;
  outOfStockItems: number;
  overstockItems: number;
  poUnitsOutstanding: number;
  pendingTransfers: number;
  notCounted: number;
  totalLocations: number;
}): AdminInventorySummary['insights'] {
  const insights: AdminInventorySummary['insights'] = [];

  if (input.outOfStockItems > 0) {
    insights.push({
      key: 'out-of-stock',
      tone: 'BAD',
      title: `${input.outOfStockItems} SKU-location(s) at zero`,
      detail: 'Every one of these is a listing a shopper can find but cannot buy.',
    });
  }
  if (input.lowStockItems > 0) {
    insights.push({
      key: 'reorder',
      tone: 'WARN',
      title: `${input.lowStockItems} item(s) at or below reorder level`,
      detail:
        input.poUnitsOutstanding > 0
          ? `${input.poUnitsOutstanding} unit(s) already on order against open POs.`
          : 'Nothing is on order to cover them yet.',
    });
  }
  if (input.overstockItems > 0) {
    insights.push({
      key: 'overstock',
      tone: 'INFO',
      title: `${input.overstockItems} item(s) holding ${OVERSTOCK_MULTIPLE}× their reorder level`,
      detail: 'Working capital sitting still — candidates for a transfer or a promotion.',
    });
  }
  if (input.pendingTransfers > 0) {
    insights.push({
      key: 'transfers',
      tone: 'INFO',
      title: `${input.pendingTransfers} unit(s) waiting on transfer dispatch`,
      detail: 'Raised but not yet sent — the stock is still at the source warehouse.',
    });
  }
  if (input.notCounted > 0 && input.totalLocations > 0) {
    const share = Math.round((input.notCounted / input.totalLocations) * 100);
    insights.push({
      key: 'uncounted',
      tone: share > 50 ? 'WARN' : 'INFO',
      title: `${share}% of locations have never been counted`,
      detail:
        'Stock accuracy only means something once a shelf has been checked against the system.',
    });
  }
  if (insights.length === 0) {
    insights.push({
      key: 'healthy',
      tone: 'GOOD',
      title: 'Nothing needs attention',
      detail: 'No stockouts, no reorder alerts and no transfers waiting.',
    });
  }
  return insights;
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

type MovementRecord = Prisma.StockMovementGetPayload<{
  include: {
    variant: { select: { sku: true; product: { select: { title: true } } } };
    fromWarehouse: { select: { name: true } };
    toWarehouse: { select: { name: true } };
    actor: { select: { name: true } };
  };
}>;

function toMovementRow(m: MovementRecord): MovementRow {
  return {
    id: m.id,
    type: m.type,
    typeLabel: MOVEMENT_TYPE_LABELS[m.type],
    sku: m.variant.sku,
    title: m.variant.product.title,
    variantId: m.variantId,
    quantity: m.quantity,
    fromWarehouse: m.fromWarehouse?.name ?? null,
    toWarehouse: m.toWarehouse?.name ?? null,
    reason: m.reason,
    reference: m.reference,
    actorName: m.actor?.name ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

const movementQuery = z.object({
  q: z.string().trim().max(80).optional(),
  type: z.enum(['ALL', ...MOVEMENT_TYPES]).default('ALL'),
  warehouseId: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(20),
});

/** Shared by the movements table and its CSV export, so both filter alike. */
function movementWhere(query: z.infer<typeof movementQuery>): Prisma.StockMovementWhereInput {
  return {
    ...(query.type === 'ALL' ? {} : { type: query.type }),
    ...(query.warehouseId
      ? {
          OR: [{ fromWarehouseId: query.warehouseId }, { toWarehouseId: query.warehouseId }],
        }
      : {}),
    ...(query.q
      ? {
          variant: {
            OR: [
              { sku: { contains: query.q, mode: 'insensitive' } },
              { product: { title: { contains: query.q, mode: 'insensitive' } } },
            ],
          },
        }
      : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
  };
}

adminInventoryRouter.get('/movements', async (req, res, next) => {
  try {
    const query = movementQuery.parse(req.query);
    const where = movementWhere(query);

    const [total, rows] = await Promise.all([
      prisma.stockMovement.count({ where }),
      prisma.stockMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          variant: { select: { sku: true, product: { select: { title: true } } } },
          fromWarehouse: { select: { name: true } },
          toWarehouse: { select: { name: true } },
          actor: { select: { name: true } },
        },
      }),
    ]);

    const body: MovementPage = {
      rows: rows.map(toMovementRow),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

adminInventoryRouter.post('/stock/adjust', async (req, res, next) => {
  try {
    const input = stockAdjustmentSchema.parse(req.body);
    const location = await prisma.stockLocation.findUnique({
      where: { id: input.locationId },
      select: { id: true, variantId: true, warehouseId: true },
    });
    if (!location) throw ApiError.notFound('Stock row not found');

    const result = await prisma.$transaction((tx) =>
      adjustStock(tx, {
        variantId: location.variantId,
        warehouseId: location.warehouseId,
        newQuantity: input.newQuantity,
        reason: input.reason,
        actorId: req.auth!.userId,
        isCount: input.isCount,
      }),
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.patch('/stock/reorder-level', async (req, res, next) => {
  try {
    const input = reorderLevelSchema.parse(req.body);
    const location = await prisma.stockLocation.findUnique({ where: { id: input.locationId } });
    if (!location) throw ApiError.notFound('Stock row not found');
    await prisma.stockLocation.update({
      where: { id: location.id },
      data: { reorderLevel: input.reorderLevel },
    });
    res.json({ success: true, data: { id: location.id, reorderLevel: input.reorderLevel } });
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.post('/stock/bulk', async (req, res, next) => {
  try {
    const input = inventoryBulkSchema.parse(req.body);
    const locations = await prisma.stockLocation.findMany({
      where: { id: { in: input.locationIds } },
      select: { id: true, variantId: true, warehouseId: true, quantity: true },
    });
    const known = new Map(locations.map((l) => [l.id, l]));

    const skipped: InventoryBulkResult['skipped'] = [];
    let updated = 0;

    for (const id of input.locationIds) {
      const location = known.get(id);
      if (!location) {
        skipped.push({ locationId: id, reason: 'Row no longer exists' });
        continue;
      }
      if (input.action === 'SET_REORDER') {
        if (input.reorderLevel === undefined) {
          skipped.push({ locationId: id, reason: 'No reorder level given' });
          continue;
        }
        await prisma.stockLocation.update({
          where: { id },
          data: { reorderLevel: input.reorderLevel },
        });
      } else if (input.action === 'MARK_COUNTED') {
        // Confirming the shelf matches the system is itself a count result.
        await prisma.stockLocation.update({
          where: { id },
          data: {
            lastCountedAt: new Date(),
            lastCountedQty: location.quantity,
            lastCountMatched: true,
          },
        });
      } else {
        if (input.newQuantity === undefined) {
          skipped.push({ locationId: id, reason: 'No new quantity given' });
          continue;
        }
        await prisma.$transaction((tx) =>
          adjustStock(tx, {
            variantId: location.variantId,
            warehouseId: location.warehouseId,
            newQuantity: input.newQuantity!,
            reason: input.reason || 'Bulk adjustment',
            actorId: req.auth!.userId,
            isCount: true,
          }),
        );
      }
      updated += 1;
    }

    const body: InventoryBulkResult = { updated, skipped };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

function blankToNull(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

adminInventoryRouter.get('/warehouses', async (_req, res, next) => {
  try {
    const [warehouses, locations] = await Promise.all([
      prisma.warehouse.findMany({ orderBy: { code: 'asc' } }),
      prisma.stockLocation.findMany({
        where: { variant: { product: { status: { not: 'ARCHIVED' } } } },
        select: {
          warehouseId: true,
          quantity: true,
          reorderLevel: true,
          variant: { select: { pricePaise: true } },
        },
        take: SCAN_CAP,
      }),
    ]);

    const stats = new Map<
      string,
      { skus: number; units: number; valuePaise: number; low: number }
    >();
    for (const l of locations) {
      const entry = stats.get(l.warehouseId) ?? { skus: 0, units: 0, valuePaise: 0, low: 0 };
      entry.skus += 1;
      entry.units += l.quantity;
      entry.valuePaise += l.quantity * l.variant.pricePaise;
      if (l.quantity <= l.reorderLevel) entry.low += 1;
      stats.set(l.warehouseId, entry);
    }

    const rows: WarehouseRow[] = warehouses.map((w) => {
      const s = stats.get(w.id) ?? { skus: 0, units: 0, valuePaise: 0, low: 0 };
      return {
        id: w.id,
        code: w.code,
        name: w.name,
        city: w.city,
        state: w.state,
        pincode: w.pincode,
        addressLine: w.addressLine,
        contactName: w.contactName,
        contactPhone: w.contactPhone,
        isActive: w.isActive,
        isDefault: w.isDefault,
        skus: s.skus,
        units: s.units,
        valuePaise: s.valuePaise,
        lowStockCount: s.low,
        createdAt: w.createdAt.toISOString(),
      };
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.post('/warehouses', async (req, res, next) => {
  try {
    const input = warehouseSchema.parse(req.body);
    const clash = await prisma.warehouse.findUnique({ where: { code: input.code } });
    if (clash) throw ApiError.badRequest(`Code ${input.code} is already in use`, 'CODE_TAKEN');

    const created = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      return tx.warehouse.create({
        data: {
          code: input.code,
          name: input.name,
          city: input.city,
          state: input.state,
          pincode: blankToNull(input.pincode),
          addressLine: blankToNull(input.addressLine),
          contactName: blankToNull(input.contactName),
          contactPhone: blankToNull(input.contactPhone),
          isActive: input.isActive,
          isDefault: input.isDefault,
        },
      });
    });
    res.status(201).json({ success: true, data: { id: created.id } });
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.patch('/warehouses/:id', async (req, res, next) => {
  try {
    const input = warehouseSchema.partial().parse(req.body);
    const warehouse = await prisma.warehouse.findUnique({ where: { id: req.params.id } });
    if (!warehouse) throw ApiError.notFound('Warehouse not found');

    if (input.code && input.code !== warehouse.code) {
      const clash = await prisma.warehouse.findUnique({ where: { code: input.code } });
      if (clash) throw ApiError.badRequest(`Code ${input.code} is already in use`, 'CODE_TAKEN');
    }
    // Deactivating a warehouse that still holds stock would strand it — the
    // stock has to be transferred out first.
    if (input.isActive === false && warehouse.isActive) {
      const held = await prisma.stockLocation.aggregate({
        where: { warehouseId: warehouse.id },
        _sum: { quantity: true },
      });
      if ((held._sum.quantity ?? 0) > 0) {
        throw ApiError.badRequest(
          `${warehouse.name} still holds ${held._sum.quantity} unit(s) — transfer them out first`,
          'WAREHOUSE_NOT_EMPTY',
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      await tx.warehouse.update({
        where: { id: warehouse.id },
        data: {
          ...(input.code ? { code: input.code } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.city ? { city: input.city } : {}),
          ...(input.state ? { state: input.state } : {}),
          ...(input.pincode !== undefined ? { pincode: blankToNull(input.pincode) } : {}),
          ...(input.addressLine !== undefined
            ? { addressLine: blankToNull(input.addressLine) }
            : {}),
          ...(input.contactName !== undefined
            ? { contactName: blankToNull(input.contactName) }
            : {}),
          ...(input.contactPhone !== undefined
            ? { contactPhone: blankToNull(input.contactPhone) }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        },
      });
    });
    res.json({ success: true, data: { id: warehouse.id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

adminInventoryRouter.get('/suppliers', async (_req, res, next) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      orderBy: { name: 'asc' },
      include: {
        purchaseOrders: {
          select: {
            createdAt: true,
            status: true,
            items: { select: { quantityReceived: true, unitCostPaise: true } },
          },
        },
      },
    });

    const rows: SupplierRow[] = suppliers.map((s) => {
      const live = s.purchaseOrders.filter((po) => po.status !== 'CANCELLED');
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        contactName: s.contactName,
        email: s.email,
        phone: s.phone,
        city: s.city,
        state: s.state,
        gstin: s.gstin,
        notes: s.notes,
        isActive: s.isActive,
        purchaseOrders: live.length,
        // Only what actually arrived counts as supplied, not what was ordered.
        unitsSupplied: live.reduce(
          (sum, po) => sum + po.items.reduce((s2, i) => s2 + i.quantityReceived, 0),
          0,
        ),
        spendPaise: live.reduce(
          (sum, po) =>
            sum + po.items.reduce((s2, i) => s2 + i.quantityReceived * i.unitCostPaise, 0),
          0,
        ),
        lastOrderAt:
          live.length > 0
            ? new Date(Math.max(...live.map((po) => po.createdAt.getTime()))).toISOString()
            : null,
        createdAt: s.createdAt.toISOString(),
      };
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.post('/suppliers', async (req, res, next) => {
  try {
    const input = supplierSchema.parse(req.body);
    const clash = await prisma.supplier.findUnique({ where: { code: input.code } });
    if (clash) throw ApiError.badRequest(`Code ${input.code} is already in use`, 'CODE_TAKEN');
    const created = await prisma.supplier.create({
      data: {
        code: input.code,
        name: input.name,
        contactName: blankToNull(input.contactName),
        email: blankToNull(input.email),
        phone: blankToNull(input.phone),
        city: blankToNull(input.city),
        state: blankToNull(input.state),
        gstin: blankToNull(input.gstin),
        notes: blankToNull(input.notes),
        isActive: input.isActive,
      },
    });
    res.status(201).json({ success: true, data: { id: created.id } });
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.patch('/suppliers/:id', async (req, res, next) => {
  try {
    const input = supplierSchema.partial().parse(req.body);
    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!supplier) throw ApiError.notFound('Supplier not found');
    if (input.code && input.code !== supplier.code) {
      const clash = await prisma.supplier.findUnique({ where: { code: input.code } });
      if (clash) throw ApiError.badRequest(`Code ${input.code} is already in use`, 'CODE_TAKEN');
    }
    await prisma.supplier.update({
      where: { id: supplier.id },
      data: {
        ...(input.code ? { code: input.code } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.contactName !== undefined ? { contactName: blankToNull(input.contactName) } : {}),
        ...(input.email !== undefined ? { email: blankToNull(input.email) } : {}),
        ...(input.phone !== undefined ? { phone: blankToNull(input.phone) } : {}),
        ...(input.city !== undefined ? { city: blankToNull(input.city) } : {}),
        ...(input.state !== undefined ? { state: blankToNull(input.state) } : {}),
        ...(input.gstin !== undefined ? { gstin: blankToNull(input.gstin) } : {}),
        ...(input.notes !== undefined ? { notes: blankToNull(input.notes) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    res.json({ success: true, data: { id: supplier.id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

const PO_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  warehouse: { select: { id: true, name: true } },
  createdBy: { select: { name: true } },
  items: {
    include: {
      variant: {
        select: { sku: true, size: true, color: true, product: { select: { title: true } } },
      },
    },
  },
} satisfies Prisma.PurchaseOrderInclude;

function toPoRow(
  po: Prisma.PurchaseOrderGetPayload<{ include: typeof PO_INCLUDE }>,
): PurchaseOrderRow {
  return {
    id: po.id,
    poNumber: po.poNumber,
    supplierId: po.supplierId,
    supplierName: po.supplier.name,
    warehouseId: po.warehouseId,
    warehouseName: po.warehouse.name,
    status: po.status,
    statusLabel: PO_STATUS_LABELS[po.status as PoStatus],
    expectedAt: po.expectedAt?.toISOString() ?? null,
    receivedAt: po.receivedAt?.toISOString() ?? null,
    notes: po.notes,
    createdByName: po.createdBy?.name ?? null,
    totalUnits: po.items.reduce((sum, i) => sum + i.quantityOrdered, 0),
    receivedUnits: po.items.reduce((sum, i) => sum + i.quantityReceived, 0),
    totalCostPaise: po.items.reduce((sum, i) => sum + i.quantityOrdered * i.unitCostPaise, 0),
    createdAt: po.createdAt.toISOString(),
    items: po.items.map((i) => ({
      id: i.id,
      variantId: i.variantId,
      sku: i.variant.sku,
      title: i.variant.product.title,
      size: i.variant.size,
      color: i.variant.color,
      quantityOrdered: i.quantityOrdered,
      quantityReceived: i.quantityReceived,
      unitCostPaise: i.unitCostPaise,
    })),
  };
}

adminInventoryRouter.get('/purchase-orders', async (req, res, next) => {
  try {
    const { status } = z
      .object({
        status: z
          .enum(['ALL', 'DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'])
          .default('ALL'),
      })
      .parse(req.query);
    const orders = await prisma.purchaseOrder.findMany({
      where: status === 'ALL' ? {} : { status },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: PO_INCLUDE,
    });
    res.json({ success: true, data: orders.map(toPoRow) });
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.post('/purchase-orders', async (req, res, next) => {
  try {
    const input = purchaseOrderSchema.parse(req.body);
    const [supplier, warehouse, variants] = await Promise.all([
      prisma.supplier.findUnique({ where: { id: input.supplierId } }),
      prisma.warehouse.findUnique({ where: { id: input.warehouseId } }),
      prisma.productVariant.findMany({
        where: { id: { in: input.items.map((i) => i.variantId) } },
        select: { id: true },
      }),
    ]);
    if (!supplier || !supplier.isActive) throw ApiError.badRequest('Pick an active supplier');
    if (!warehouse || !warehouse.isActive) throw ApiError.badRequest('Pick an active warehouse');
    const known = new Set(variants.map((v) => v.id));
    const unknown = input.items.filter((i) => !known.has(i.variantId));
    if (unknown.length > 0) throw ApiError.badRequest('One of the lines is not a real variant');

    // Two admins raising a PO in the same second would collide on the number.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const poNumber = await nextDocumentNumber('PO', attempt);
      try {
        const created = await prisma.purchaseOrder.create({
          data: {
            poNumber,
            supplierId: input.supplierId,
            warehouseId: input.warehouseId,
            status: 'ORDERED',
            expectedAt: input.expectedAt ? new Date(input.expectedAt) : null,
            notes: blankToNull(input.notes),
            createdById: req.auth!.userId,
            items: {
              create: input.items.map((i) => ({
                variantId: i.variantId,
                quantityOrdered: i.quantityOrdered,
                unitCostPaise: i.unitCostPaise,
              })),
            },
          },
        });
        res.status(201).json({ success: true, data: { id: created.id, poNumber } });
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    throw new Error('Could not allocate a purchase-order number');
  } catch (err) {
    next(err);
  }
});

/**
 * Receive stock against a PO. Each line adds real units to the destination
 * warehouse through the ledger, so the dashboard's "Today's Receipts" and the
 * variant total both move as a result of this one call.
 */
adminInventoryRouter.post('/purchase-orders/:id/receive', async (req, res, next) => {
  try {
    const input = receivePurchaseOrderSchema.parse(req.body);
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!po) throw ApiError.notFound('Purchase order not found');
    if (po.status === 'CANCELLED') throw ApiError.badRequest('This PO was cancelled');
    if (po.status === 'RECEIVED') throw ApiError.badRequest('This PO is already fully received');

    const byId = new Map(po.items.map((i) => [i.id, i]));
    for (const line of input.lines) {
      const item = byId.get(line.itemId);
      if (!item) throw ApiError.badRequest('One of the lines is not on this PO');
      if (item.quantityReceived + line.quantity > item.quantityOrdered) {
        throw ApiError.badRequest(
          `Line ${item.id} would receive more than was ordered`,
          'OVER_RECEIPT',
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const line of input.lines) {
        if (line.quantity <= 0) continue;
        const item = byId.get(line.itemId)!;
        await receiveStock(tx, {
          variantId: item.variantId,
          warehouseId: po.warehouseId,
          quantity: line.quantity,
          reason: 'Purchase order receipt',
          reference: po.poNumber,
          actorId: req.auth!.userId,
        });
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { quantityReceived: { increment: line.quantity } },
        });
      }

      const fresh = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
      const complete = fresh.every((i) => i.quantityReceived >= i.quantityOrdered);
      const started = fresh.some((i) => i.quantityReceived > 0);
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: {
          status: complete ? 'RECEIVED' : started ? 'PARTIAL' : po.status,
          receivedAt: complete ? new Date() : po.receivedAt,
        },
      });
    });

    const updated = await prisma.purchaseOrder.findUnique({
      where: { id: po.id },
      include: PO_INCLUDE,
    });
    res.json({ success: true, data: toPoRow(updated!) });
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.patch('/purchase-orders/:id/status', async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['ORDERED', 'CANCELLED']) }).parse(req.body);
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!po) throw ApiError.notFound('Purchase order not found');
    if (status === 'CANCELLED' && po.items.some((i) => i.quantityReceived > 0)) {
      throw ApiError.badRequest(
        'Stock has already been received against this PO — it cannot be cancelled',
        'PO_PARTIALLY_RECEIVED',
      );
    }
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status } });
    res.json({ success: true, data: { id: po.id, status } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

const TRANSFER_INCLUDE = {
  fromWarehouse: { select: { name: true } },
  toWarehouse: { select: { name: true } },
  createdBy: { select: { name: true } },
  items: { include: { variant: { select: { sku: true, product: { select: { title: true } } } } } },
} satisfies Prisma.StockTransferInclude;

function toTransferRow(
  t: Prisma.StockTransferGetPayload<{ include: typeof TRANSFER_INCLUDE }>,
): TransferRow {
  return {
    id: t.id,
    transferNumber: t.transferNumber,
    fromWarehouse: t.fromWarehouse.name,
    toWarehouse: t.toWarehouse.name,
    status: t.status,
    statusLabel: TRANSFER_STATUS_LABELS[t.status as TransferStatus],
    totalUnits: t.items.reduce((sum, i) => sum + i.quantity, 0),
    notes: t.notes,
    createdByName: t.createdBy?.name ?? null,
    createdAt: t.createdAt.toISOString(),
    dispatchedAt: t.dispatchedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    items: t.items.map((i) => ({
      variantId: i.variantId,
      sku: i.variant.sku,
      title: i.variant.product.title,
      quantity: i.quantity,
    })),
  };
}

adminInventoryRouter.get('/transfers', async (_req, res, next) => {
  try {
    const transfers = await prisma.stockTransfer.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: TRANSFER_INCLUDE,
    });
    res.json({ success: true, data: transfers.map(toTransferRow) });
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.post('/transfers', async (req, res, next) => {
  try {
    const input = transferSchema.parse(req.body);
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw ApiError.badRequest('Pick two different warehouses');
    }
    const [from, to] = await Promise.all([
      prisma.warehouse.findUnique({ where: { id: input.fromWarehouseId } }),
      prisma.warehouse.findUnique({ where: { id: input.toWarehouseId } }),
    ]);
    if (!from || !to || !to.isActive) throw ApiError.badRequest('Pick two active warehouses');

    // Refuse up front rather than failing halfway through the dispatch.
    const locations = await prisma.stockLocation.findMany({
      where: {
        warehouseId: input.fromWarehouseId,
        variantId: { in: input.items.map((i) => i.variantId) },
      },
      select: { variantId: true, quantity: true, variant: { select: { sku: true } } },
    });
    const held = new Map(locations.map((l) => [l.variantId, l]));
    for (const item of input.items) {
      const location = held.get(item.variantId);
      if (!location || location.quantity < item.quantity) {
        throw ApiError.badRequest(
          `${location?.variant.sku ?? 'That SKU'} has only ${location?.quantity ?? 0} unit(s) at ${from.name}`,
          'INSUFFICIENT_STOCK',
        );
      }
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const transferNumber = await nextDocumentNumber('TRF', attempt);
      try {
        const created = await prisma.stockTransfer.create({
          data: {
            transferNumber,
            fromWarehouseId: input.fromWarehouseId,
            toWarehouseId: input.toWarehouseId,
            status: 'PENDING',
            notes: blankToNull(input.notes),
            createdById: req.auth!.userId,
            items: { create: input.items },
          },
        });
        res.status(201).json({ success: true, data: { id: created.id, transferNumber } });
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    throw new Error('Could not allocate a transfer number');
  } catch (err) {
    next(err);
  }
});

/**
 * PENDING → IN_TRANSIT → COMPLETED. The stock only actually moves on COMPLETED,
 * so an in-flight transfer shows as incoming at the destination without ever
 * being counted twice.
 */
adminInventoryRouter.patch('/transfers/:id/status', async (req, res, next) => {
  try {
    const { status } = transferStatusSchema.parse(req.body);
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!transfer) throw ApiError.notFound('Transfer not found');
    if (['COMPLETED', 'CANCELLED'].includes(transfer.status)) {
      throw ApiError.badRequest('This transfer is already closed');
    }
    if (status === 'IN_TRANSIT' && transfer.status !== 'PENDING') {
      throw ApiError.badRequest('Only a pending transfer can be dispatched');
    }

    if (status === 'COMPLETED') {
      await prisma.$transaction(async (tx) => {
        for (const item of transfer.items) {
          await moveBetweenWarehouses(tx, {
            variantId: item.variantId,
            fromWarehouseId: transfer.fromWarehouseId,
            toWarehouseId: transfer.toWarehouseId,
            quantity: item.quantity,
            reason: 'Warehouse transfer',
            reference: transfer.transferNumber,
            actorId: req.auth!.userId,
          });
        }
        await tx.stockTransfer.update({
          where: { id: transfer.id },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
      });
    } else {
      await prisma.stockTransfer.update({
        where: { id: transfer.id },
        data: {
          status,
          ...(status === 'IN_TRANSIT' ? { dispatchedAt: new Date() } : {}),
        },
      });
    }
    res.json({ success: true, data: { id: transfer.id, status } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Meta + export
// ---------------------------------------------------------------------------

adminInventoryRouter.get('/meta/options', async (_req, res, next) => {
  try {
    const [warehouses, categories, brands, sellers, suppliers] = await Promise.all([
      prisma.warehouse.findMany({
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true, isActive: true },
      }),
      prisma.category.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      prisma.sellerProfile.findMany({
        orderBy: { shopName: 'asc' },
        select: { id: true, shopName: true },
      }),
      prisma.supplier.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true },
      }),
    ]);
    const body: InventoryFilterOptions = {
      warehouses,
      categories,
      brands,
      sellers: sellers.map((s) => ({ id: s.id, name: s.shopName })),
      suppliers,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

/** Variant lookup for building a PO or a transfer line. */
adminInventoryRouter.get('/meta/variants', async (req, res, next) => {
  try {
    const { q, warehouseId } = z
      .object({ q: z.string().trim().min(1).max(80), warehouseId: z.string().trim().optional() })
      .parse(req.query);

    const variants = await prisma.productVariant.findMany({
      where: {
        product: { status: { not: 'ARCHIVED' } },
        OR: [
          { sku: { contains: q, mode: 'insensitive' } },
          { product: { title: { contains: q, mode: 'insensitive' } } },
        ],
      },
      take: 12,
      select: {
        id: true,
        sku: true,
        size: true,
        color: true,
        pricePaise: true,
        stock: true,
        product: { select: { title: true } },
        stockLocations: warehouseId
          ? { where: { warehouseId }, select: { quantity: true } }
          : { select: { quantity: true } },
      },
    });

    res.json({
      success: true,
      data: variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        title: v.product.title,
        size: v.size,
        color: v.color,
        pricePaise: v.pricePaise,
        totalStock: v.stock,
        atWarehouse: v.stockLocations.reduce((sum, l) => sum + l.quantity, 0),
      })),
    });
  } catch (err) {
    next(err);
  }
});

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

adminInventoryRouter.get('/stock/export', async (req, res, next) => {
  try {
    const rows = await loadStockRows(stockQuery.parse(req.query));
    const header = [
      'SKU',
      'Product',
      'Category',
      'Brand',
      'Seller',
      'Size',
      'Colour',
      'Warehouse',
      'Available',
      'Reserved',
      'Incoming',
      'Reorder level',
      'Status',
      'Unit price (₹)',
      'Stock value (₹)',
      'Last updated',
    ].join(',');
    const body = rows
      .map((r) =>
        [
          r.sku,
          r.title,
          r.categoryName,
          r.brandName ?? '',
          r.sellerName,
          r.size,
          r.color,
          `${r.warehouseName} (${r.warehouseCode})`,
          r.available,
          r.reserved,
          r.incoming,
          r.reorderLevel,
          r.statusLabel,
          (r.unitPricePaise / 100).toFixed(2),
          (r.stockValuePaise / 100).toFixed(2),
          r.updatedAt,
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
    res.send(`${header}\n${body}`);
  } catch (err) {
    next(err);
  }
});

/** The movement ledger as CSV, honouring the same filters as the table. */
adminInventoryRouter.get('/movements/export', async (req, res, next) => {
  try {
    const query = movementQuery.parse({ ...req.query, page: 1, pageSize: 200 });
    const rows = await prisma.stockMovement.findMany({
      where: movementWhere(query),
      orderBy: { createdAt: 'desc' },
      take: 10000,
      include: {
        variant: { select: { sku: true, product: { select: { title: true } } } },
        fromWarehouse: { select: { name: true } },
        toWarehouse: { select: { name: true } },
        actor: { select: { name: true } },
      },
    });

    const header = [
      'When',
      'Type',
      'SKU',
      'Product',
      'Quantity',
      'From',
      'To',
      'Reason',
      'Reference',
      'By',
    ].join(',');
    const body = rows
      .map((m) =>
        [
          m.createdAt.toISOString(),
          MOVEMENT_TYPE_LABELS[m.type],
          m.variant.sku,
          m.variant.product.title,
          m.quantity,
          m.fromWarehouse?.name ?? '',
          m.toWarehouse?.name ?? '',
          m.reason ?? '',
          m.reference ?? '',
          m.actor?.name ?? 'System',
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="stock-movements.csv"');
    res.send(`${header}\n${body}`);
  } catch (err) {
    next(err);
  }
});

/** One row per warehouse: what it holds and what it is worth. */
adminInventoryRouter.get('/warehouses/export', async (_req, res, next) => {
  try {
    const [warehouses, locations] = await Promise.all([
      prisma.warehouse.findMany({ orderBy: { code: 'asc' } }),
      prisma.stockLocation.findMany({
        where: { variant: { product: { status: { not: 'ARCHIVED' } } } },
        select: {
          warehouseId: true,
          quantity: true,
          reorderLevel: true,
          variant: { select: { pricePaise: true } },
        },
        take: SCAN_CAP,
      }),
    ]);
    const stats = new Map<string, { skus: number; units: number; value: number; low: number }>();
    for (const l of locations) {
      const entry = stats.get(l.warehouseId) ?? { skus: 0, units: 0, value: 0, low: 0 };
      entry.skus += 1;
      entry.units += l.quantity;
      entry.value += l.quantity * l.variant.pricePaise;
      if (l.quantity <= l.reorderLevel) entry.low += 1;
      stats.set(l.warehouseId, entry);
    }

    const header = [
      'Code',
      'Warehouse',
      'City',
      'State',
      'Pincode',
      'Active',
      'Default',
      'SKUs',
      'Units',
      'Stock value (₹)',
      'Low stock rows',
    ].join(',');
    const body = warehouses
      .map((w) => {
        const s = stats.get(w.id) ?? { skus: 0, units: 0, value: 0, low: 0 };
        return [
          w.code,
          w.name,
          w.city,
          w.state,
          w.pincode ?? '',
          w.isActive ? 'Yes' : 'No',
          w.isDefault ? 'Yes' : 'No',
          s.skus,
          s.units,
          (s.value / 100).toFixed(2),
          s.low,
        ]
          .map(csvCell)
          .join(',');
      })
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="warehouses.csv"');
    res.send(`${header}\n${body}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Direct receipt — stock arriving without a purchase order
// ---------------------------------------------------------------------------

adminInventoryRouter.post('/stock/receive', async (req, res, next) => {
  try {
    const input = directReceiptSchema.parse(req.body);
    const warehouse = await prisma.warehouse.findUnique({ where: { id: input.warehouseId } });
    if (!warehouse || !warehouse.isActive) throw ApiError.badRequest('Pick an active warehouse');

    const variants = await prisma.productVariant.findMany({
      where: { id: { in: input.lines.map((l) => l.variantId) } },
      select: { id: true },
    });
    const known = new Set(variants.map((v) => v.id));
    if (input.lines.some((l) => !known.has(l.variantId))) {
      throw ApiError.badRequest('One of the lines is not a real variant');
    }

    await prisma.$transaction(async (tx) => {
      for (const line of input.lines) {
        await receiveStock(tx, {
          variantId: line.variantId,
          warehouseId: input.warehouseId,
          quantity: line.quantity,
          reason: input.reason,
          reference: input.reference || undefined,
          actorId: req.auth!.userId,
        });
      }
    });

    const units = input.lines.reduce((sum, l) => sum + l.quantity, 0);
    res.json({ success: true, data: { units, warehouseName: warehouse.name } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Import — a stock sheet keyed by SKU + warehouse code
// ---------------------------------------------------------------------------

adminInventoryRouter.post('/stock/import', async (req, res, next) => {
  try {
    const input = inventoryImportSchema.parse(req.body);

    const [variants, warehouses] = await Promise.all([
      prisma.productVariant.findMany({
        where: { sku: { in: [...new Set(input.rows.map((r) => r.sku))] } },
        select: { id: true, sku: true },
      }),
      prisma.warehouse.findMany({ select: { id: true, code: true, isActive: true } }),
    ]);
    const variantBySku = new Map(variants.map((v) => [v.sku.toUpperCase(), v.id]));
    const warehouseByCode = new Map(warehouses.map((w) => [w.code.toUpperCase(), w]));

    const skipped: InventoryImportResult['skipped'] = [];
    let applied = 0;
    let quantityChanged = 0;
    let reorderChanged = 0;

    for (const [index, row] of input.rows.entries()) {
      const rowNumber = index + 1;
      const variantId = variantBySku.get(row.sku.toUpperCase());
      if (!variantId) {
        skipped.push({ row: rowNumber, sku: row.sku, reason: 'No product has that SKU' });
        continue;
      }
      const warehouse = warehouseByCode.get(row.warehouseCode.toUpperCase());
      if (!warehouse) {
        skipped.push({
          row: rowNumber,
          sku: row.sku,
          reason: `No warehouse with code ${row.warehouseCode}`,
        });
        continue;
      }
      if (!warehouse.isActive) {
        skipped.push({
          row: rowNumber,
          sku: row.sku,
          reason: `${row.warehouseCode} is not an active warehouse`,
        });
        continue;
      }
      if (row.quantity === undefined && row.reorderLevel === undefined) {
        skipped.push({ row: rowNumber, sku: row.sku, reason: 'No quantity or reorder level' });
        continue;
      }

      const existing = await prisma.stockLocation.findUnique({
        where: { warehouseId_variantId: { warehouseId: warehouse.id, variantId } },
        select: { id: true, quantity: true },
      });

      if (row.quantity !== undefined) {
        const target =
          input.mode === 'SET' ? row.quantity : (existing?.quantity ?? 0) + row.quantity;
        const result = await prisma.$transaction((tx) =>
          adjustStock(tx, {
            variantId,
            warehouseId: warehouse.id,
            newQuantity: target,
            reason: input.reason,
            actorId: req.auth!.userId,
            isCount: input.isCount,
          }),
        );
        if (result.delta !== 0) quantityChanged += 1;
      }

      if (row.reorderLevel !== undefined) {
        const location = await prisma.stockLocation.findUnique({
          where: { warehouseId_variantId: { warehouseId: warehouse.id, variantId } },
          select: { id: true, reorderLevel: true },
        });
        if (location && location.reorderLevel !== row.reorderLevel) {
          await prisma.stockLocation.update({
            where: { id: location.id },
            data: { reorderLevel: row.reorderLevel },
          });
          reorderChanged += 1;
        }
      }
      applied += 1;
    }

    const body: InventoryImportResult = { applied, quantityChanged, reorderChanged, skipped };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
