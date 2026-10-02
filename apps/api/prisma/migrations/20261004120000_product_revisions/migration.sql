-- Edits to live listings wait here for review; the live listing stays as approved.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Additive only: a new enum and table, empty until a seller edits a live listing.
CREATE TYPE "ProductRevisionStatus" AS ENUM ('DRAFT', 'PENDING', 'REJECTED');

CREATE TABLE "product_revisions" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "ProductRevisionStatus" NOT NULL,
    "content" JSONB NOT NULL,
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_revisions_productId_key" ON "product_revisions"("productId");
CREATE INDEX "product_revisions_status_submittedAt_idx" ON "product_revisions"("status", "submittedAt");

ALTER TABLE "product_revisions" ADD CONSTRAINT "product_revisions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
