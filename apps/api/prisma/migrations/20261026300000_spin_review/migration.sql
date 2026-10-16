-- Owner: a 360° view is reviewed by an admin before it goes live, like product images.
ALTER TABLE "products" ADD COLUMN "spinImagesPending" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "products" ADD COLUMN "spinImagesSubmittedAt" TIMESTAMP(3);
