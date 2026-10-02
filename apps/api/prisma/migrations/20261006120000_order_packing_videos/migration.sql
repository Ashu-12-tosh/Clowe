-- Packing videos move from the listing to the order: one clip per seller per
-- order, required before dispatch, private, kept until 45 days after delivery
-- and while a return is open. The per-product columns stay as they are: the
-- clips already stored there are kept, and no longer shown.
CREATE TABLE "order_packing_videos" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "fileRef" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "order_packing_videos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_packing_videos_orderId_sellerId_key" ON "order_packing_videos"("orderId", "sellerId");
CREATE INDEX "order_packing_videos_deletedAt_uploadedAt_idx" ON "order_packing_videos"("deletedAt", "uploadedAt");

ALTER TABLE "order_packing_videos" ADD CONSTRAINT "order_packing_videos_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_packing_videos" ADD CONSTRAINT "order_packing_videos_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
