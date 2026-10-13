-- A variant removed by its seller after it was ordered is retired, not deleted:
-- its order lines still reference it.
ALTER TABLE "product_variants" ADD COLUMN "retiredAt" TIMESTAMP(3);
