-- Owner's Batch 2: fee changes announced at least 30 days ahead, applied on their date.
CREATE TYPE "FeeChangeStatus" AS ENUM ('SCHEDULED', 'APPLIED', 'CANCELLED');

CREATE TABLE "scheduled_fee_changes" (
    "id" TEXT NOT NULL,
    "patch" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "status" "FeeChangeStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    CONSTRAINT "scheduled_fee_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "scheduled_fee_changes_status_effectiveAt_idx" ON "scheduled_fee_changes"("status", "effectiveAt");
