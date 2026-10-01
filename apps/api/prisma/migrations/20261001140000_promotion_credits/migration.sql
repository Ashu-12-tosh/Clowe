-- Promotion credits: a seller's top-ups, and the ledger link that credits each once.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Additive only: one table for pending gateway payments and one nullable
-- column on the ledger. The (purchaseId, type) unique pair is what makes a
-- settled purchase credit the PROMOTION bucket exactly once, however many
-- times the gateway callback or the dev mock-pay is replayed.

-- AlterTable
ALTER TABLE "seller_ledger_entries" ADD COLUMN     "purchaseId" TEXT;

-- CreateTable
CREATE TABLE "promotion_credit_purchases" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "providerOrderId" TEXT,
    "providerPaymentId" TEXT,
    "status" "CreditPurchaseStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotion_credit_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotion_credit_purchases_sellerId_createdAt_idx" ON "promotion_credit_purchases"("sellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "seller_ledger_entries_purchaseId_type_key" ON "seller_ledger_entries"("purchaseId", "type");

-- AddForeignKey
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "seller_ledger_entries_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "promotion_credit_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_credit_purchases" ADD CONSTRAINT "promotion_credit_purchases_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
