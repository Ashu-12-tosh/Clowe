-- Owner: brand authorization documents for brands an admin marks as requiring one.
CREATE TYPE "BrandAuthStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');
ALTER TABLE "brands" ADD COLUMN "authorizationRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN "brandAuthDoc" TEXT;
ALTER TABLE "products" ADD COLUMN "brandAuthStatus" "BrandAuthStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "products" ADD COLUMN "brandAuthNote" TEXT;
ALTER TABLE "products" ADD COLUMN "brandAuthSubmittedAt" TIMESTAMP(3);
ALTER TABLE "products" ADD COLUMN "brandAuthReviewedAt" TIMESTAMP(3);
