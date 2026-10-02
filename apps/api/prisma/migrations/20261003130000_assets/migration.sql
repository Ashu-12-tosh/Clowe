-- Stored files, and what each is for.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Additive only: a new enum and table. Existing URL columns are rewritten to
-- asset references by scripts/backfillPrivateAssets.ts, not here, because the
-- files themselves have to move.
CREATE TYPE "AssetPurpose" AS ENUM ('RETURN_PHOTO', 'TRYON_PHOTO', 'TRYON_RESULT', 'PACKING_VIDEO');

CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "purpose" "AssetPurpose" NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assets_ownerId_idx" ON "assets"("ownerId");
CREATE INDEX "assets_purpose_createdAt_idx" ON "assets"("purpose", "createdAt");
CREATE UNIQUE INDEX "assets_provider_key_key" ON "assets"("provider", "key");

ALTER TABLE "assets" ADD CONSTRAINT "assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
