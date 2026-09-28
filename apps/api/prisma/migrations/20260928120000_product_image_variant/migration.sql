-- Per-variant product images.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Additive only: one new table. Nothing existing is altered, so every current
-- listing keeps exactly the gallery it has.
--
-- Why a table and not a nullable "variantId" on product_images: roughly forty
-- queries across the API load product.images, most of them `take: 1` ordered by
-- sortOrder, for card thumbnails, the suggest dropdown and order rows. A column
-- on that table would feed variant pictures into all of them, so each would
-- need a `WHERE "variantId" IS NULL` it does not have — and the next such query
-- written would quietly take the wrong thumbnail. A separate table cannot leak
-- that way.

CREATE TABLE "product_variant_images" (
    "id"        TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "url"       TEXT NOT NULL,
    "altText"   TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_variant_images_pkey" PRIMARY KEY ("id")
);

-- The only read there is: one variant's pictures, already in display order.
CREATE INDEX "product_variant_images_variantId_sortOrder_idx"
  ON "product_variant_images"("variantId", "sortOrder");

-- Cascade matches product_images: deleting a variant takes its pictures with
-- it, and leaves the product's own images untouched.
ALTER TABLE "product_variant_images" ADD CONSTRAINT "product_variant_images_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "product_variants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
