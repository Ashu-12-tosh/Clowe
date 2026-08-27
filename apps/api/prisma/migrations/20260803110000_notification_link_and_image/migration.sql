-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "linkHref" TEXT;

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

