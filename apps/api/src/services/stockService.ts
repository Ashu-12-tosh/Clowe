import type { Prisma, StockMovementType, Warehouse } from '@prisma/client';
import { istDate } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';

/**
 * Every change to stock goes through here.
 *
 * Two numbers have to agree at all times:
 *   - `ProductVariant.stock` — what checkout guards against, read all over the app
 *   - `sum(StockLocation.quantity)` for that variant — where the stock physically is
 *
 * Helpers that move stock update the locations and then re-derive the variant
 * total, so the two can never drift. The one exception is checkout, which has
 * already decremented the variant atomically as its out-of-stock guard; it calls
 * `allocateForDispatch` which only drains the locations to match.
 */

type Tx = Prisma.TransactionClient;

const DEFAULT_WAREHOUSE = {
  code: 'MAIN-01',
  name: 'Main Warehouse',
  city: 'Mumbai',
  state: 'Maharashtra',
};

/**
 * The warehouse new stock lands in. Creates one on first use so a fresh install
 * is never in a state where stock has nowhere to go.
 */
/**
 * Lines in the order their stock rows are locked: by variant id, the same in
 * every transaction. Two multi-item orders taking (or giving back) stock in
 * different orders each held a row the other needed, and Postgres killed one
 * of them as a deadlock (pre-launch test, 76 times under load).
 */
export function inLockOrder<T extends { variantId: string }>(lines: readonly T[]): T[] {
  // Plain code-unit order: the same as Postgres ORDER BY id COLLATE "C" (lockVariants).
  return [...lines].sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));
}

export async function ensureDefaultWarehouse(): Promise<Warehouse> {
  const existing = await prisma.warehouse.findFirst({
    where: { isDefault: true, isActive: true },
  });
  if (existing) return existing;

  // A previous default may have been deactivated — promote any active one
  // rather than silently creating a second "Main Warehouse".
  const fallback = await prisma.warehouse.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (fallback) {
    return prisma.warehouse.update({ where: { id: fallback.id }, data: { isDefault: true } });
  }
  return prisma.warehouse.create({ data: { ...DEFAULT_WAREHOUSE, isDefault: true } });
}

/**
 * Locks variant rows, in id order, before any warehouse row is touched. Orders
 * lock the variant first and then its locations (checkout, cancel, RTO): every
 * inventory change does the same, so the two never wait on each other in a
 * circle (a Postgres deadlock, the buyer's Pay or the seller's save failing).
 */
export async function lockVariants(tx: Tx, variantIds: readonly string[]): Promise<void> {
  const ids = [...new Set(variantIds)].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM "product_variants" WHERE id = ANY(${ids}::text[]) ORDER BY id COLLATE "C" FOR NO KEY UPDATE`;
}

/** Re-derive `ProductVariant.stock` from the per-warehouse rows. */
async function syncVariantStock(tx: Tx, variantId: string): Promise<number> {
  const agg = await tx.stockLocation.aggregate({
    where: { variantId },
    _sum: { quantity: true },
  });
  const total = agg._sum.quantity ?? 0;
  // Only raising it past the ceiling is refused: a product above it (units that
  // came back at the ceiling) can still be counted down or moved.
  if (total > MAX_STOCK) {
    const was = (await tx.productVariant.findUnique({ where: { id: variantId }, select: { stock: true } }))?.stock ?? 0;
    if (total > was) throw stockLimit();
  }
  await tx.productVariant.update({ where: { id: variantId }, data: { stock: total } });
  return total;
}

async function addToLocation(
  tx: Tx,
  warehouseId: string,
  variantId: string,
  delta: number,
  /** Units that were on sale already (a cancel, a failed payment): never refused by the ceiling. */
  returning = false,
): Promise<void> {
  const location = await tx.stockLocation.findUnique({
    where: { warehouseId_variantId: { warehouseId, variantId } },
  });
  if (!location) {
    if (delta < 0) throw ApiError.badRequest('No stock in that warehouse', 'NO_STOCK');
    if (delta > MAX_STOCK && !returning) throw stockLimit();
    await tx.stockLocation.create({ data: { warehouseId, variantId, quantity: delta } });
    return;
  }
  const next = location.quantity + delta;
  if (next > MAX_STOCK && !returning) throw stockLimit();
  if (next < 0) {
    throw ApiError.badRequest(
      `Only ${location.quantity} unit(s) in that warehouse`,
      'INSUFFICIENT_STOCK',
    );
  }
  await tx.stockLocation.update({ where: { id: location.id }, data: { quantity: next } });
}

interface MovementInput {
  type: StockMovementType;
  variantId: string;
  quantity: number;
  fromWarehouseId?: string | null;
  toWarehouseId?: string | null;
  reason?: string | null;
  reference?: string | null;
  actorId?: string | null;
}

function writeMovement(tx: Tx, input: MovementInput) {
  return tx.stockMovement.create({
    data: {
      type: input.type,
      variantId: input.variantId,
      quantity: input.quantity,
      fromWarehouseId: input.fromWarehouseId ?? null,
      toWarehouseId: input.toWarehouseId ?? null,
      reason: input.reason ?? null,
      reference: input.reference ?? null,
      actorId: input.actorId ?? null,
    },
  });
}

/**
 * The stock on sale, put where the warehouse rows can see it. A variant made
 * on the product form (or before inventory existed) carries its stock with no
 * warehouse row, and every warehouse action re-derives the variant's stock
 * from those rows — so receiving one unit turned 50 into 1 (pre-launch test).
 * Before any warehouse change, the difference goes into the default warehouse
 * as an opening balance (or, if the rows hold more than is on sale, comes off
 * them), recorded in the ledger. What is on sale is what buyers were sold
 * against, so it wins. Call with the variant locked.
 *
 * `into`: the warehouse it belongs in (a count or adjustment: that count is
 * the truth for its warehouse). Otherwise the default warehouse, or — before
 * one is set, as on a fresh install — `fallback`, the warehouse acted on.
 */
async function reconcileLocations(tx: Tx, variantId: string, place: { into?: string; fallback?: string } = {}): Promise<void> {
  const variant = await tx.productVariant.findUnique({ where: { id: variantId }, select: { stock: true } });
  if (!variant) return;
  const agg = await tx.stockLocation.aggregate({ where: { variantId }, _sum: { quantity: true } });
  const diff = variant.stock - (agg._sum.quantity ?? 0);
  if (diff === 0) return;
  if (diff > 0) {
    const home =
      place.into ?? (await tx.warehouse.findFirst({ where: { isDefault: true, isActive: true }, select: { id: true } }))?.id ?? place.fallback;
    if (!home) return;
    await addToLocation(tx, home, variantId, diff);
    await writeMovement(tx, {
      type: 'RECEIPT',
      variantId,
      quantity: diff,
      toWarehouseId: home,
      reason: 'Opening balance: stock on sale with no warehouse row',
    });
    return;
  }
  let extra = -diff;
  const rows = await tx.stockLocation.findMany({ where: { variantId, quantity: { gt: 0 } }, orderBy: { quantity: 'desc' } });
  for (const row of rows) {
    if (extra <= 0) break;
    const take = Math.min(row.quantity, extra);
    await tx.stockLocation.update({ where: { id: row.id }, data: { quantity: row.quantity - take } });
    await writeMovement(tx, {
      type: 'ADJUSTMENT',
      variantId,
      quantity: take,
      fromWarehouseId: row.warehouseId,
      reason: 'Correction: warehouse rows held more than was on sale',
    });
    extra -= take;
  }
}

/** Stock arriving: a purchase-order receipt, an opening balance, a return. */
export async function receiveStock(
  tx: Tx,
  input: {
    variantId: string;
    warehouseId: string;
    quantity: number;
    type?: StockMovementType;
    reason?: string;
    reference?: string;
    actorId?: string | null;
  },
): Promise<void> {
  if (input.quantity <= 0) throw ApiError.badRequest('Quantity must be at least 1');
  await lockVariants(tx, [input.variantId]);
  await reconcileLocations(tx, input.variantId, { fallback: input.warehouseId });
  await addToLocation(tx, input.warehouseId, input.variantId, input.quantity);
  await writeMovement(tx, {
    type: input.type ?? 'RECEIPT',
    variantId: input.variantId,
    quantity: input.quantity,
    toWarehouseId: input.warehouseId,
    reason: input.reason,
    reference: input.reference,
    actorId: input.actorId,
  });
  await syncVariantStock(tx, input.variantId);
}

/**
 * Drain `quantity` units out of the warehouses that hold them, largest holding
 * first, and log a DISPATCH per warehouse touched.
 *
 * Checkout has already decremented `ProductVariant.stock`, so this deliberately
 * does not re-sync — it brings the locations back in line with that decrement.
 * Returns the units it could not place (only possible if the two had already
 * drifted), so the caller can decide whether that is worth shouting about.
 */
export async function allocateForDispatch(
  tx: Tx,
  input: { variantId: string; quantity: number; reference?: string; actorId?: string | null },
): Promise<number> {
  const locations = await tx.stockLocation.findMany({
    where: { variantId: input.variantId, quantity: { gt: 0 } },
    orderBy: { quantity: 'desc' },
  });

  let remaining = input.quantity;
  for (const location of locations) {
    if (remaining <= 0) break;
    const take = Math.min(location.quantity, remaining);
    await tx.stockLocation.update({
      where: { id: location.id },
      data: { quantity: location.quantity - take },
    });
    await writeMovement(tx, {
      type: 'DISPATCH',
      variantId: input.variantId,
      quantity: take,
      fromWarehouseId: location.warehouseId,
      reason: 'Customer order',
      reference: input.reference,
      actorId: input.actorId,
    });
    remaining -= take;
  }
  return remaining;
}

/**
 * Put units back after a cancellation or a return. Prefers the warehouse the
 * order shipped from so stock returns where it came from.
 */
export async function returnStock(
  tx: Tx,
  input: {
    variantId: string;
    quantity: number;
    warehouseId?: string;
    reason?: string;
    reference?: string;
    actorId?: string | null;
  },
): Promise<void> {
  if (input.quantity <= 0) return;

  let warehouseId = input.warehouseId;
  if (!warehouseId) {
    const shippedFrom = await tx.stockMovement.findFirst({
      where: {
        variantId: input.variantId,
        type: 'DISPATCH',
        reference: input.reference ?? undefined,
      },
      orderBy: { createdAt: 'desc' },
      select: { fromWarehouseId: true },
    });
    warehouseId = shippedFrom?.fromWarehouseId ?? undefined;
  }
  if (!warehouseId) {
    const anyLocation = await tx.stockLocation.findFirst({
      where: { variantId: input.variantId },
      orderBy: { quantity: 'desc' },
      select: { warehouseId: true },
    });
    warehouseId = anyLocation?.warehouseId;
  }
  if (!warehouseId) {
    const fallback = await tx.warehouse.findFirst({
      where: { isDefault: true, isActive: true },
      select: { id: true },
    });
    warehouseId = fallback?.id;
  }
  // No warehouse anywhere means inventory was never set up; the variant total is
  // still corrected by the caller, so silently skipping the ledger is wrong —
  // but failing a customer refund over bookkeeping is worse.
  if (!warehouseId) return;

  await addToLocation(tx, warehouseId, input.variantId, input.quantity, true);
  await writeMovement(tx, {
    type: 'RETURN',
    variantId: input.variantId,
    quantity: input.quantity,
    toWarehouseId: warehouseId,
    reason: input.reason ?? 'Order cancelled',
    reference: input.reference,
    actorId: input.actorId,
  });
}

/**
 * Correct a warehouse's count to what a human actually found. `newQuantity` is
 * absolute; the difference becomes the movement.
 */
export async function adjustStock(
  tx: Tx,
  input: {
    variantId: string;
    warehouseId: string;
    /** The warehouse's new quantity (a count, an absolute set)… */
    newQuantity?: number;
    /** …or units added to (or, negative, taken from) what the row holds now. */
    addQuantity?: number;
    reason: string;
    actorId?: string | null;
    /** Set when this came from a cycle count, so accuracy can be reported. */
    isCount?: boolean;
  },
): Promise<{ before: number; after: number; delta: number }> {
  await lockVariants(tx, [input.variantId]);
  // A count or an absolute set is the truth for its warehouse, so stock on
  // sale with no row is placed there; an addition is not a count.
  await reconcileLocations(
    tx,
    input.variantId,
    input.addQuantity === undefined ? { into: input.warehouseId } : { fallback: input.warehouseId },
  );

  const location = await tx.stockLocation.findUnique({
    where: {
      warehouseId_variantId: { warehouseId: input.warehouseId, variantId: input.variantId },
    },
  });
  const before = location?.quantity ?? 0;
  // "Add" is worked out here, after the variant's stock on sale has been put
  // into its rows: read before that, an import's "+1" overwrote it (25 → 1).
  const newQuantity = input.addQuantity !== undefined ? before + input.addQuantity : (input.newQuantity ?? before);
  if (newQuantity < 0) throw ApiError.badRequest('Stock cannot go below zero');
  if (newQuantity > MAX_STOCK) throw stockLimit();
  const delta = newQuantity - before;

  if (location) {
    await tx.stockLocation.update({
      where: { id: location.id },
      data: {
        quantity: newQuantity,
        ...(input.isCount
          ? {
              lastCountedAt: new Date(),
              lastCountedQty: newQuantity,
              lastCountMatched: delta === 0,
            }
          : {}),
      },
    });
  } else {
    await tx.stockLocation.create({
      data: {
        warehouseId: input.warehouseId,
        variantId: input.variantId,
        quantity: newQuantity,
        ...(input.isCount
          ? {
              lastCountedAt: new Date(),
              lastCountedQty: newQuantity,
              lastCountMatched: delta === 0,
            }
          : {}),
      },
    });
  }

  // A count that matched changes nothing, so there is nothing to log.
  if (delta !== 0) {
    await writeMovement(tx, {
      type: 'ADJUSTMENT',
      variantId: input.variantId,
      quantity: Math.abs(delta),
      ...(delta > 0
        ? { toWarehouseId: input.warehouseId }
        : { fromWarehouseId: input.warehouseId }),
      reason: input.reason,
      actorId: input.actorId,
    });
  }
  await syncVariantStock(tx, input.variantId);
  return { before, after: newQuantity, delta };
}

/** Move units between two warehouses. The variant total is unchanged. */
export async function moveBetweenWarehouses(
  tx: Tx,
  input: {
    variantId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    quantity: number;
    reason?: string;
    reference?: string;
    actorId?: string | null;
  },
): Promise<void> {
  if (input.quantity <= 0) throw ApiError.badRequest('Quantity must be at least 1');
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw ApiError.badRequest('Pick two different warehouses');
  }
  await lockVariants(tx, [input.variantId]);
  await reconcileLocations(tx, input.variantId, { fallback: input.fromWarehouseId });
  await addToLocation(tx, input.fromWarehouseId, input.variantId, -input.quantity);
  await addToLocation(tx, input.toWarehouseId, input.variantId, input.quantity);
  await writeMovement(tx, {
    type: 'TRANSFER',
    variantId: input.variantId,
    quantity: input.quantity,
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    reason: input.reason,
    reference: input.reference,
    actorId: input.actorId,
  });
  await syncVariantStock(tx, input.variantId);
}

/**
 * A seller's stock change for one variant: a new total, or "+N / −N" applied
 * to the stock as it is now — read under the variant's lock, so a sale, a
 * cancel or another edit landing at the same moment is never overwritten
 * (pre-launch test: reading it before the transaction put sold units back on
 * sale). Never below zero. Returns the new total.
 */
/** The most units one variant can hold (the seller screens' limit). */
export const MAX_STOCK = 1_000_000;
const stockLimit = () => ApiError.badRequest('A product can hold at most 1,000,000 units', 'STOCK_LIMIT');

export async function changeSellerStock(
  tx: Tx,
  input: {
    variantId: string;
    stock?: number;
    delta?: number;
    defaultWarehouseId: string;
    reason: string;
    actorId?: string | null;
    /**
     * This exact change, once: a save retried after its answer was lost (the
     * first one may still be committing) finds its movement and is skipped.
     */
    onceKey?: string;
  },
): Promise<number> {
  await lockVariants(tx, [input.variantId]);
  const now = (await tx.productVariant.findUniqueOrThrow({ where: { id: input.variantId }, select: { stock: true } })).stock;
  if (input.onceKey && (await tx.stockMovement.count({ where: { variantId: input.variantId, reference: input.onceKey } })) > 0) {
    return now;
  }
  // The inventory screen's ceiling: a stock column is a 32-bit integer.
  // Never past the ceiling, and an addition never lowers a product already above it.
  const next = Math.min(Math.max(MAX_STOCK, now), input.stock !== undefined ? input.stock : Math.max(0, now + (input.delta ?? 0)));
  await setVariantTotal(tx, {
    variantId: input.variantId,
    newTotal: next,
    defaultWarehouseId: input.defaultWarehouseId,
    reason: input.reason,
    reference: input.onceKey,
    actorId: input.actorId,
  });
  return next;
}

/**
 * Set a variant's total to an absolute figure without caring which warehouse —
 * what the seller's own inventory screen does. Increases land in the default
 * warehouse; decreases come off the largest holdings first.
 */
export async function setVariantTotal(
  tx: Tx,
  input: {
    variantId: string;
    newTotal: number;
    defaultWarehouseId: string;
    reason: string;
    /** Written on the movements (a form save's key, so a retry is recognised). */
    reference?: string;
    actorId?: string | null;
  },
): Promise<void> {
  await lockVariants(tx, [input.variantId]);
  await reconcileLocations(tx, input.variantId, { fallback: input.defaultWarehouseId });
  const agg = await tx.stockLocation.aggregate({
    where: { variantId: input.variantId },
    _sum: { quantity: true },
  });
  const current = agg._sum.quantity ?? 0;
  const delta = input.newTotal - current;
  if (delta === 0) {
    await syncVariantStock(tx, input.variantId);
    return;
  }

  if (delta > 0) {
    await addToLocation(tx, input.defaultWarehouseId, input.variantId, delta);
    await writeMovement(tx, {
      type: 'ADJUSTMENT',
      variantId: input.variantId,
      quantity: delta,
      toWarehouseId: input.defaultWarehouseId,
      reason: input.reason,
      reference: input.reference,
      actorId: input.actorId,
    });
  } else {
    let remaining = -delta;
    const locations = await tx.stockLocation.findMany({
      where: { variantId: input.variantId, quantity: { gt: 0 } },
      orderBy: { quantity: 'desc' },
    });
    for (const location of locations) {
      if (remaining <= 0) break;
      const take = Math.min(location.quantity, remaining);
      await tx.stockLocation.update({
        where: { id: location.id },
        data: { quantity: location.quantity - take },
      });
      await writeMovement(tx, {
        type: 'ADJUSTMENT',
        variantId: input.variantId,
        quantity: take,
        fromWarehouseId: location.warehouseId,
        reason: input.reason,
        reference: input.reference,
        actorId: input.actorId,
      });
      remaining -= take;
    }
  }
  await syncVariantStock(tx, input.variantId);
}

/**
 * Sequential document numbers, e.g. PO-2026-000042. The count-then-insert race
 * is handled by the caller retrying on a unique-constraint clash.
 */
export async function nextDocumentNumber(prefix: 'PO' | 'TRF', attempt = 0): Promise<string> {
  const year = istDate(new Date()).year;
  const count =
    prefix === 'PO' ? await prisma.purchaseOrder.count() : await prisma.stockTransfer.count();
  return `${prefix}-${year}-${String(count + 1 + attempt).padStart(6, '0')}`;
}
