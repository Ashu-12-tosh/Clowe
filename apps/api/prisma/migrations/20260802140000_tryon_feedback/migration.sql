-- AlterTable
ALTER TABLE "tryon_history" ADD COLUMN     "feedback" TEXT,
ADD COLUMN     "variantColor" TEXT,
ADD COLUMN     "variantSize" TEXT;

-- CreateIndex
CREATE INDEX "tryon_history_userId_productId_createdAt_idx" ON "tryon_history"("userId", "productId", "createdAt");

