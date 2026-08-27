-- AlterTable
ALTER TABLE "tryon_history" ADD COLUMN     "deviceType" TEXT,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "flagReason" TEXT,
ADD COLUMN     "flagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "flaggedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "tryon_history_createdAt_idx" ON "tryon_history"("createdAt");

-- CreateIndex
CREATE INDEX "tryon_history_status_createdAt_idx" ON "tryon_history"("status", "createdAt");

-- CreateIndex
CREATE INDEX "tryon_history_flagged_createdAt_idx" ON "tryon_history"("flagged", "createdAt");
