-- TDS and TCS at the rates in force.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- The enum value comes first: Postgres will not use a value added in the same
-- transaction, and nothing below needs it.
ALTER TYPE "SellerLedgerType" ADD VALUE 'GST_TCS';

-- s.194-O TDS has been 0.1% since 1.10.2024 (Finance (No. 2) Act 2024, s.61).
-- A stored rate is corrected only if it still holds the old default of 1%:
-- a value an admin chose on purpose is left alone.
UPDATE "platform_settings" SET "value" = '0.1'::jsonb WHERE "key" = 'payoutTdsPercent' AND "value" = '1'::jsonb;
