-- 360° product view: an ordered set of images around the product.
ALTER TABLE "products" ADD COLUMN "spinImages" TEXT[] DEFAULT ARRAY[]::TEXT[];
