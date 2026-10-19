-- Cashfree: gateway sessions and expiry on payments and top-ups, async refund
-- states with the bank reference (ARN), payout approval and transfer
-- tracking, payout beneficiaries, Easy Split vendors and splits, and the
-- webhook events table that makes redeliveries harmless.

-- AlterEnum (new values are only added here, not used, so this is safe in
-- the migration's transaction)
ALTER TYPE "PayoutStatus" ADD VALUE 'REJECTED';
ALTER TYPE "PayoutStatus" ADD VALUE 'REVERSED';

-- AlterEnum
ALTER TYPE "RefundStatus" ADD VALUE 'PROCESSING';

-- AlterEnum
ALTER TYPE "SellerLedgerType" ADD VALUE 'EASY_SPLIT_SHARE';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "easySplitPaise" INTEGER;

-- AlterTable
ALTER TABLE "credit_purchases" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "paymentSessionId" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "paymentSessionId" TEXT,
ADD COLUMN     "settlementMode" TEXT NOT NULL DEFAULT 'payouts';

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "providerTransferId" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "transferId" TEXT;

-- AlterTable
ALTER TABLE "promotion_credit_purchases" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "paymentSessionId" TEXT;

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "arn" TEXT,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "vendorSplits" JSONB,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "seller_payout_methods" ADD COLUMN     "beneficiaryId" TEXT;

-- AlterTable
ALTER TABLE "seller_profiles" ADD COLUMN     "cashfreeVendorId" TEXT,
ADD COLUMN     "cashfreeVendorStatus" TEXT,
ADD COLUMN     "cashfreeVendorSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "payment_splits" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "refundedPaise" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "releasedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "utr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reference" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_splits_status_idx" ON "payment_splits"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_splits_paymentId_sellerId_key" ON "payment_splits"("paymentId", "sellerId");

-- CreateIndex
CREATE INDEX "gateway_webhook_events_receivedAt_idx" ON "gateway_webhook_events"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_webhook_events_provider_eventKey_key" ON "gateway_webhook_events"("provider", "eventKey");

-- CreateIndex
CREATE INDEX "payments_providerOrderId_idx" ON "payments"("providerOrderId");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_transferId_key" ON "payouts"("transferId");

-- CreateIndex
CREATE INDEX "payouts_status_requestedAt_idx" ON "payouts"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "seller_profiles_cashfreeVendorId_key" ON "seller_profiles"("cashfreeVendorId");

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_splits" ADD CONSTRAINT "payment_splits_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_splits" ADD CONSTRAINT "payment_splits_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Payouts made before this keep a transfer id in the format Cashfree accepts.
UPDATE "payouts" SET "transferId" = replace("reference", '-', '_') WHERE "transferId" IS NULL;
