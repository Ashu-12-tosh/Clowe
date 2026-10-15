-- A separate image for phones (below 640px) on banners and promo tiles.
ALTER TABLE "home_banners" ADD COLUMN "mobileImageUrl" TEXT;
ALTER TABLE "category_banners" ADD COLUMN "mobileImageUrl" TEXT;
ALTER TABLE "promo_tiles" ADD COLUMN "mobileImageUrl" TEXT;
