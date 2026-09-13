-- Sellers upload a packing video with each listing; it expires after 10 days.
ALTER TABLE "products" ADD COLUMN "packingVideoUrl" TEXT,
ADD COLUMN "packingVideoUploadedAt" TIMESTAMP(3);
