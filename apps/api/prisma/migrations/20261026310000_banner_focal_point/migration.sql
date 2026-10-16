-- Owner: a focal point on hero slides, category banners and promo tiles, kept in view at every width.
ALTER TABLE "home_banners" ADD COLUMN "focalX" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "home_banners" ADD COLUMN "focalY" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "promo_tiles" ADD COLUMN "focalX" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "promo_tiles" ADD COLUMN "focalY" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "category_banners" ADD COLUMN "focalX" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "category_banners" ADD COLUMN "focalY" INTEGER NOT NULL DEFAULT 50;
