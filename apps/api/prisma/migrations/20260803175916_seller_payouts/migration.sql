-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutMethodType" AS ENUM ('BANK', 'UPI');

-- AlterTable
ALTER TABLE "ads" ADD COLUMN     "payoutId" TEXT;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "payoutId" TEXT;

-- CreateTable
CREATE TABLE "seller_payout_methods" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "type" "PayoutMethodType" NOT NULL DEFAULT 'BANK',
    "label" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountLast4" TEXT,
    "ifsc" TEXT,
    "upiId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seller_payout_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "grossPaise" INTEGER NOT NULL,
    "commissionPaise" INTEGER NOT NULL DEFAULT 0,
    "gatewayPaise" INTEGER NOT NULL DEFAULT 0,
    "otherFeesPaise" INTEGER NOT NULL DEFAULT 0,
    "adjustmentPaise" INTEGER NOT NULL DEFAULT 0,
    "tdsPaise" INTEGER NOT NULL DEFAULT 0,
    "netPaise" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "methodId" TEXT,
    "methodLabel" TEXT,
    "utr" TEXT,
    "failureReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seller_payout_methods_sellerId_isDefault_idx" ON "seller_payout_methods"("sellerId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_reference_key" ON "payouts"("reference");

-- CreateIndex
CREATE INDEX "payouts_sellerId_requestedAt_idx" ON "payouts"("sellerId", "requestedAt");

-- CreateIndex
CREATE INDEX "ads_sellerId_payoutId_idx" ON "ads"("sellerId", "payoutId");

-- CreateIndex
CREATE INDEX "order_items_sellerId_payoutId_idx" ON "order_items"("sellerId", "payoutId");

-- AddForeignKey
ALTER TABLE "seller_payout_methods" ADD CONSTRAINT "seller_payout_methods_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "seller_payout_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
