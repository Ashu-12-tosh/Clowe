-- CreateEnum
CREATE TYPE "SellerReferralStatus" AS ENUM ('PENDING', 'EARNED', 'VOID');

-- CreateEnum
CREATE TYPE "AdPlacement" AS ENUM ('HOME_BANNER', 'CATEGORY_SPONSORED');

-- CreateEnum
CREATE TYPE "AdStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "seller_profiles" ADD COLUMN     "referralCode" TEXT;

-- CreateTable
CREATE TABLE "seller_referrals" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "status" "SellerReferralStatus" NOT NULL DEFAULT 'PENDING',
    "rewardPaise" INTEGER NOT NULL DEFAULT 0,
    "earnedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seller_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ads" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "placement" "AdPlacement" NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "pricePaise" INTEGER NOT NULL,
    "status" "AdStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "views" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seller_referrals_referredId_key" ON "seller_referrals"("referredId");

-- CreateIndex
CREATE INDEX "ads_status_placement_idx" ON "ads"("status", "placement");

-- CreateIndex
CREATE UNIQUE INDEX "seller_profiles_referralCode_key" ON "seller_profiles"("referralCode");

-- AddForeignKey
ALTER TABLE "seller_referrals" ADD CONSTRAINT "seller_referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_referrals" ADD CONSTRAINT "seller_referrals_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

