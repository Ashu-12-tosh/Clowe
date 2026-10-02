-- GST TCS in its own column on payouts, and the taxable value it was taken on.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Two new columns, then one backfill. Payouts made before this counted the
-- TCS on their lines inside otherFeesPaise (the reconciling remainder); it is
-- moved to tcsPaise from the ledger entries those very lines posted, so each
-- row still adds up: net = gross - commission - gateway - other - TDS - TCS
-- - adjustments. taxablePaise stays null on older TCS entries; the GSTR-8
-- export recalculates those.
ALTER TABLE "payouts" ADD COLUMN "tcsPaise" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "seller_ledger_entries" ADD COLUMN "taxablePaise" INTEGER;

UPDATE "payouts" AS p
SET "tcsPaise" = t.tcs, "otherFeesPaise" = p."otherFeesPaise" - t.tcs
FROM (
  SELECT oi."payoutId", (-SUM(e."amountPaise"))::integer AS tcs
  FROM "seller_ledger_entries" AS e
  JOIN "order_items" AS oi ON oi."id" = e."orderItemId"
  WHERE e."type" = 'GST_TCS' AND e."bucket" = 'SETTLEMENT' AND oi."payoutId" IS NOT NULL
  GROUP BY oi."payoutId"
) AS t
WHERE p."id" = t."payoutId";
