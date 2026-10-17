-- Owner: no mock "verified" — manual KYC review, the seller's own bank account (encrypted), brand proofs per seller and brand.
CREATE TYPE "KycReviewStatus" AS ENUM ('VERIFIED', 'REJECTED');

CREATE TABLE "seller_kyc_reviews" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "kind" "KycCheckType" NOT NULL,
    "status" "KycReviewStatus" NOT NULL,
    "subject" TEXT NOT NULL,
    "reason" TEXT,
    "reviewerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "seller_kyc_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "seller_kyc_reviews_sellerId_kind_createdAt_idx" ON "seller_kyc_reviews"("sellerId", "kind", "createdAt");
ALTER TABLE "seller_kyc_reviews" ADD CONSTRAINT "seller_kyc_reviews_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "seller_brand_proofs" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "proofType" TEXT NOT NULL,
    "doc" TEXT NOT NULL,
    "status" "BrandAuthStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "expiresAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewerId" TEXT,
    CONSTRAINT "seller_brand_proofs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "seller_brand_proofs_sellerId_brandId_key" ON "seller_brand_proofs"("sellerId", "brandId");
CREATE INDEX "seller_brand_proofs_status_submittedAt_idx" ON "seller_brand_proofs"("status", "submittedAt");
ALTER TABLE "seller_brand_proofs" ADD CONSTRAINT "seller_brand_proofs_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seller_brand_proofs" ADD CONSTRAINT "seller_brand_proofs_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "seller_profiles" ADD COLUMN "bankAccountEnc" TEXT;
ALTER TABLE "seller_profiles" ADD COLUMN "bankAccountLast4" TEXT;
ALTER TABLE "seller_profiles" ADD COLUMN "bankAccountType" TEXT;
ALTER TABLE "seller_profiles" ADD COLUMN "bankChequeDoc" TEXT;
ALTER TABLE "seller_profiles" ADD COLUMN "bankSubmittedAt" TIMESTAMP(3);
