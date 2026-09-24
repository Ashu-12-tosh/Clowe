-- Seller KYC verification: one row per call to the verification provider.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Additive only: three enums, two nullable columns, one new table.

CREATE TYPE "KycCheckType" AS ENUM ('PAN', 'GSTIN', 'BANK');

CREATE TYPE "KycCheckOutcome" AS ENUM ('VERIFIED', 'FAILED', 'ERROR');

CREATE TYPE "NameMatchBand" AS ENUM ('DIRECT_MATCH', 'GOOD_PARTIAL_MATCH', 'MODERATE_PARTIAL_MATCH', 'POOR_PARTIAL_MATCH', 'NO_MATCH');

ALTER TABLE "seller_profiles" ADD COLUMN "kycCheckStartedAt" TIMESTAMP(3),
ADD COLUMN "panName" TEXT;

CREATE TABLE "seller_kyc_checks" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "kind" "KycCheckType" NOT NULL,
    "outcome" "KycCheckOutcome" NOT NULL,
    "reason" TEXT,
    "nameScore" INTEGER,
    "nameBand" "NameMatchBand",
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "nameSubject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seller_kyc_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "seller_kyc_checks_sellerId_kind_createdAt_idx" ON "seller_kyc_checks"("sellerId", "kind", "createdAt");

ALTER TABLE "seller_kyc_checks" ADD CONSTRAINT "seller_kyc_checks_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
