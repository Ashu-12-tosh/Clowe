import type { Prisma, StockMovementType, Warehouse } from '@prisma/client';
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

/** Re-derive `ProductVariant.stock` from the per-warehouse rows. */
async function syncVariantStock(tx: Tx, variantId: string): Promise<number> {
  const agg = await tx.stockLocation.aggregate({
    where: { variantId },
    _sum: { quantity: true },
  });
  const total = agg._sum.quantity ?? 0;
  await tx.productVariant.update({ where: { id: variantId }, data: { stock: total } });
  return total;
}

async function addToLocation(
  tx: Tx,
  warehouseId: string,
  variantId: string,
  delta: number,
): Promise<void> {
  const location = await tx.stockLocation.findUnique({
    where: { warehouseId_variantId: { warehouseId, variantId } },
  });
  if (!location) {
    if (delta < 0) throw ApiError.badRequest('No stock in that warehouse', 'NO_STOCK');
    await tx.stockLocation.create({ data: { warehouseId, variantId, quantity: delta } });
    return;
  }
  const next = location.quantity + delta;
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

  await addToLocation(tx, warehouseId, input.variantId, input.quantity);
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
    newQuantity: number;
    reason: string;
    actorId?: string | null;
    /** Set when this came from a cycle count, so accuracy can be reported. */
    isCount?: boolean;
  },
): Promise<{ before: number; after: number; delta: number }> {
  if (input.newQuantity < 0) throw ApiError.badRequest('Stock cannot go below zero');

  const location = await tx.stockLocation.findUnique({
    where: {
      warehouseId_variantId: { warehouseId: input.warehouseId, variantId: input.variantId },
    },
  });
  const before = location?.quantity ?? 0;
  const delta = input.newQuantity - before;

  if (location) {
    await tx.stockLocation.update({
      where: { id: location.id },
      data: {
        quantity: input.newQuantity,
        ...(input.isCount
          ? {
              lastCountedAt: new Date(),
              lastCountedQty: input.newQuantity,
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
        quantity: input.newQuantity,
        ...(input.isCount
          ? {
              lastCountedAt: new Date(),
              lastCountedQty: input.newQuantity,
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
  return { before, after: input.newQuantity, delta };
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
    actorId?: string | null;
  },
): Promise<void> {
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
  const year = new Date().getFullYear();
  const count =
    prefix === 'PO' ? await prisma.purchaseOrder.count() : await prisma.stockTransfer.count();
  return `${prefix}-${year}-${String(count + 1 + attempt).padStart(6, '0')}`;
}
