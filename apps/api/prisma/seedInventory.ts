/**
 * One-off inventory backfill.
 *
 * Before this, stock was a single number on the variant with no notion of where
 * it physically sat. This script creates the warehouse network and suppliers,
 * then books every variant's existing stock in as an opening-balance receipt so
 * `sum(StockLocation.quantity)` matches `ProductVariant.stock` from day one.
 *
 * It does NOT invent movement history. Where existing stock is placed is a
 * choice, not a record — there was no prior truth about location — so it is
 * spread deterministically by SKU and logged honestly as "Opening balance".
 * Receipts, dispatches and adjustments from here on are real events.
 *
 * Safe to re-run: warehouses/suppliers are upserted by code, and a variant that
 * already has a location is left alone.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const WAREHOUSES = [
  {
    code: 'DEL-01',
    name: 'Delhi Warehouse',
    city: 'New Delhi',
    state: 'Delhi',
    pincode: '110037',
    isDefault: true,
  },
  {
    code: 'MUM-01',
    name: 'Mumbai Warehouse',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400072',
    isDefault: false,
  },
  {
    code: 'BLR-01',
    name: 'Bangalore Warehouse',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560103',
    isDefault: false,
  },
  {
    code: 'HYD-01',
    name: 'Hyderabad Warehouse',
    city: 'Hyderabad',
    state: 'Telangana',
    pincode: '500081',
    isDefault: false,
  },
  {
    code: 'CCU-01',
    name: 'Kolkata Warehouse',
    city: 'Kolkata',
    state: 'West Bengal',
    pincode: '700091',
    isDefault: false,
  },
  {
    code: 'MAA-01',
    name: 'Chennai Warehouse',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600032',
    isDefault: false,
  },
];

const SUPPLIERS = [
  {
    code: 'SUP-001',
    name: 'Tirupur Knit Exports',
    city: 'Tirupur',
    state: 'Tamil Nadu',
    contactName: 'R. Karthik',
    phone: '9840012345',
    email: 'orders@tirupurknits.example',
  },
  {
    code: 'SUP-002',
    name: 'Ludhiana Woollen Mills',
    city: 'Ludhiana',
    state: 'Punjab',
    contactName: 'H. Singh',
    phone: '9815022345',
    email: 'sales@ludhianawool.example',
  },
  {
    code: 'SUP-003',
    name: 'Surat Textile House',
    city: 'Surat',
    state: 'Gujarat',
    contactName: 'M. Patel',
    phone: '9825032345',
    email: 'contact@surattextile.example',
  },
  {
    code: 'SUP-004',
    name: 'Noida Electronics Depot',
    city: 'Noida',
    state: 'Uttar Pradesh',
    contactName: 'A. Verma',
    phone: '9910042345',
    email: 'supply@noidaelec.example',
  },
  {
    code: 'SUP-005',
    name: 'Jaipur Handicraft Co.',
    city: 'Jaipur',
    state: 'Rajasthan',
    contactName: 'S. Meena',
    phone: '9414052345',
    email: 'hello@jaipurcraft.example',
  },
];

/** Stable 0..n-1 bucket from a SKU, so re-runs place stock the same way. */
function bucketOf(sku: string, buckets: number): number {
  let hash = 0;
  for (let i = 0; i < sku.length; i += 1) hash = (hash * 31 + sku.charCodeAt(i)) >>> 0;
  return hash % buckets;
}

async function main() {
  console.log('[inventory] creating warehouses…');
  for (const w of WAREHOUSES) {
    await prisma.warehouse.upsert({
      where: { code: w.code },
      update: { name: w.name, city: w.city, state: w.state, pincode: w.pincode },
      create: w,
    });
  }

  console.log('[inventory] creating suppliers…');
  for (const s of SUPPLIERS) {
    await prisma.supplier.upsert({ where: { code: s.code }, update: { name: s.name }, create: s });
  }

  const warehouses = await prisma.warehouse.findMany({
    where: { isActive: true },
    orderBy: { code: 'asc' },
  });
  const variants = await prisma.productVariant.findMany({
    select: { id: true, sku: true, stock: true, product: { select: { lowStockAlert: true } } },
  });
  console.log(`[inventory] booking opening balances for ${variants.length} variants…`);

  let placed = 0;
  let skipped = 0;
  for (const variant of variants) {
    const already = await prisma.stockLocation.count({ where: { variantId: variant.id } });
    if (already > 0) {
      skipped += 1;
      continue;
    }

    // Most of the stock sits in one warehouse, with a slice held at a second
    // site — the usual shape for a marketplace running a hub and a spoke.
    const home = warehouses[bucketOf(variant.sku, warehouses.length)]!;
    const spoke = warehouses[bucketOf(`${variant.sku}#2`, warehouses.length)]!;
    const splits: { warehouseId: string; quantity: number }[] = [];

    if (variant.stock > 0) {
      const spokeQty = home.id === spoke.id ? 0 : Math.floor(variant.stock * 0.3);
      const homeQty = variant.stock - spokeQty;
      if (homeQty > 0) splits.push({ warehouseId: home.id, quantity: homeQty });
      if (spokeQty > 0) splits.push({ warehouseId: spoke.id, quantity: spokeQty });
    } else {
      // Zero-stock variants still need a row so they show as out of stock
      // against a real warehouse rather than vanishing from the report.
      splits.push({ warehouseId: home.id, quantity: 0 });
    }

    const reorderLevel = Math.max(5, variant.product.lowStockAlert);
    await prisma.$transaction(async (tx) => {
      for (const split of splits) {
        await tx.stockLocation.create({
          data: {
            warehouseId: split.warehouseId,
            variantId: variant.id,
            quantity: split.quantity,
            reorderLevel,
          },
        });
        if (split.quantity > 0) {
          await tx.stockMovement.create({
            data: {
              type: 'RECEIPT',
              variantId: variant.id,
              quantity: split.quantity,
              toWarehouseId: split.warehouseId,
              reason: 'Opening balance',
              reference: 'OPENING',
            },
          });
        }
      }
    });
    placed += 1;
  }

  console.log(`[inventory] placed ${placed} variants, skipped ${skipped} already located.`);

  // Prove the invariant the whole system rests on.
  const mismatched = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM product_variants v
    LEFT JOIN (
      SELECT "variantId", SUM(quantity) AS total FROM stock_locations GROUP BY "variantId"
    ) l ON l."variantId" = v.id
    WHERE COALESCE(l.total, 0) <> v.stock
  `;
  const bad = Number(mismatched[0]?.count ?? 0);
  console.log(
    bad === 0
      ? '[inventory] ✓ every variant total matches its warehouse rows'
      : `[inventory] ✗ ${bad} variant(s) out of sync — investigate before going live`,
  );
  if (bad > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
