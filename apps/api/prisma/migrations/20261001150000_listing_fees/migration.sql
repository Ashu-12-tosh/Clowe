-- Two more ledger types, for the fixed fees the pricing calculator introduces.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Additive only: enum values are appended, so the existing ordering and every
-- row already written are untouched. PLATFORM_FEE existed from the first
-- ledger migration; DELIVERY_FEE and CLOSING_FEE join it now that the shared
-- calculator posts all three on delivery.

-- AlterEnum
ALTER TYPE "SellerLedgerType" ADD VALUE 'DELIVERY_FEE';
ALTER TYPE "SellerLedgerType" ADD VALUE 'CLOSING_FEE';
