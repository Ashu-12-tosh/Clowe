-- The seller ledger: one signed row per money event, balances summed over it.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Additive only: two enums and one table. Nothing is backfilled here —
-- historical deliveries are picked up lazily per seller by the ledger service
-- the first time their balance is read, so the migration itself is instant and
-- safe to run on a live database.
--
-- The three unique pairs are the idempotency guards: a delivery, a penalty, a
-- waiver, a payout or an ad charge can only ever post once against the record
-- it is about, whatever path led there. Nulls are distinct under a unique
-- index, so entries without that reference are unconstrained.

-- CreateEnum
CREATE TYPE "SellerLedgerType" AS ENUM ('SALE_EARNING', 'COMMISSION', 'PLATFORM_FEE', 'GATEWAY_FEE', 'TDS', 'LATE_DISPATCH_PENALTY', 'PENALTY_WAIVER', 'RETURN_REVERSAL', 'PROMOTION_CREDIT_PURCHASE', 'PROMOTION_CREDIT_SPEND', 'PAYOUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "SellerLedgerBucket" AS ENUM ('SETTLEMENT', 'PROMOTION');

-- CreateTable
CREATE TABLE "seller_ledger_entries" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "type" "SellerLedgerType" NOT NULL,
    "bucket" "SellerLedgerBucket" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "payoutId" TEXT,
    "adId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seller_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seller_ledger_entries_sellerId_bucket_createdAt_idx" ON "seller_ledger_entries"("sellerId", "bucket", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "seller_ledger_entries_orderItemId_type_key" ON "seller_ledger_entries"("orderItemId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "seller_ledger_entries_payoutId_type_key" ON "seller_ledger_entries"("payoutId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "seller_ledger_entries_adId_type_key" ON "seller_ledger_entries"("adId", "type");

-- AddForeignKey
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "seller_ledger_entries_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "seller_ledger_entries_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "seller_ledger_entries_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "seller_ledger_entries_adId_fkey" FOREIGN KEY ("adId") REFERENCES "ads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "seller_ledger_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
