-- A banner or promo tile can be a full image: the image is the whole banner
-- (text and buttons baked in), one link, with alt text for screen readers.
CREATE TYPE "BannerImageMode" AS ENUM ('DESIGNED', 'FULL_IMAGE');

ALTER TABLE "home_banners" ADD COLUMN "altText" TEXT,
ADD COLUMN "imageMode" "BannerImageMode" NOT NULL DEFAULT 'DESIGNED';

ALTER TABLE "category_banners" ADD COLUMN "altText" TEXT,
ADD COLUMN "imageMode" "BannerImageMode" NOT NULL DEFAULT 'DESIGNED';

ALTER TABLE "promo_tiles" ADD COLUMN "altText" TEXT,
ADD COLUMN "imageMode" "BannerImageMode" NOT NULL DEFAULT 'DESIGNED';
