-- CreateEnum
CREATE TYPE "PromoPlacement" AS ENUM ('PROMO_CARD', 'PROMO_STRIP');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "icon" TEXT;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "optionValues" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "isBestSeller" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isNew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isTrending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mrpPaise" INTEGER,
ADD COLUMN     "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "ratingCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "soldCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_views" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_banners" (
    "id" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "highlight" TEXT,
    "subtext" TEXT,
    "imageUrl" TEXT,
    "primaryLabel" TEXT NOT NULL DEFAULT 'Shop Now',
    "primaryHref" TEXT NOT NULL DEFAULT '/products',
    "secondaryLabel" TEXT,
    "secondaryHref" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "home_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_tiles" (
    "id" TEXT NOT NULL,
    "placement" "PromoPlacement" NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "imageUrl" TEXT,
    "href" TEXT NOT NULL DEFAULT '/products',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_tiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Deals of the Day',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_items" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "deal_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_subscribers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_slug_key" ON "brands"("slug");

-- CreateIndex
CREATE INDEX "product_views_createdAt_idx" ON "product_views"("createdAt");

-- CreateIndex
CREATE INDEX "product_views_productId_createdAt_idx" ON "product_views"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "promo_tiles_placement_isActive_sortOrder_idx" ON "promo_tiles"("placement", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "deals_isActive_startAt_endAt_idx" ON "deals"("isActive", "startAt", "endAt");

-- CreateIndex
CREATE UNIQUE INDEX "deal_items_dealId_productId_key" ON "deal_items"("dealId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscribers_email_key" ON "newsletter_subscribers"("email");

-- CreateIndex
CREATE INDEX "products_status_soldCount_idx" ON "products"("status", "soldCount");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_views" ADD CONSTRAINT "product_views_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_items" ADD CONSTRAINT "deal_items_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_items" ADD CONSTRAINT "deal_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Backfill so the existing clothing catalogue keeps working unchanged.
-- ---------------------------------------------------------------------------

-- Structured option values for existing size/color variants.
UPDATE "product_variants"
SET "optionValues" = jsonb_build_object('size', "size", 'color', "color")
WHERE "optionValues" = '{}'::jsonb;

-- Product MRP from the highest variant MRP (keeps % OFF working everywhere).
UPDATE "products" p
SET "mrpPaise" = v."maxMrp"
FROM (
  SELECT "productId", MAX("mrpPaise") AS "maxMrp"
  FROM "product_variants" WHERE "mrpPaise" IS NOT NULL GROUP BY "productId"
) v
WHERE p."id" = v."productId" AND p."mrpPaise" IS NULL;

-- Rating cache from existing reviews.
UPDATE "products" p
SET "ratingAvg" = r."avgRating", "ratingCount" = r."cnt"
FROM (
  SELECT "productId", ROUND(AVG("rating")::numeric, 1)::double precision AS "avgRating",
         COUNT(*)::int AS "cnt"
  FROM "reviews" GROUP BY "productId"
) r
WHERE p."id" = r."productId";

-- Sold counts from order history.
UPDATE "products" p
SET "soldCount" = o."qty"
FROM (
  SELECT "productId", SUM("quantity")::int AS "qty" FROM "order_items" GROUP BY "productId"
) o
WHERE p."id" = o."productId";
