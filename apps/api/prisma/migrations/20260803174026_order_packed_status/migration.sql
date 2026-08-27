-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'PACKED';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "packedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "order_items_sellerId_orderId_idx" ON "order_items"("sellerId", "orderId");
