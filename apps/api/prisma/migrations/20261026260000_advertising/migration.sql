-- Owner's Batch 2: advertising and sponsorship campaigns, slot calendar, clicks, stats, attribution.
CREATE TYPE "AdCampaignKind" AS ENUM ('CPC', 'PACKAGE', 'PLACEMENT', 'SMART');
CREATE TYPE "AdCampaignStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'ENDED', 'REJECTED');

CREATE TABLE "ad_campaigns" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "kind" "AdCampaignKind" NOT NULL,
    "sponsorship" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "adTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "packageKey" TEXT,
    "placement" TEXT,
    "categoryId" TEXT,
    "productId" TEXT,
    "bidPaise" INTEGER,
    "dailyBudgetPaise" INTEGER,
    "monthlyBudgetPaise" INTEGER,
    "goal" TEXT,
    "totalBudgetPaise" INTEGER,
    "pricePaise" INTEGER NOT NULL DEFAULT 0,
    "status" "AdCampaignStatus" NOT NULL DEFAULT 'ACTIVE',
    "rejectionReason" TEXT,
    "creativeUrl" TEXT,
    "headline" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ad_campaigns_status_kind_idx" ON "ad_campaigns"("status", "kind");
CREATE INDEX "ad_campaigns_sellerId_createdAt_idx" ON "ad_campaigns"("sellerId", "createdAt");
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ad_slot_bookings" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "space" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "day" DATE NOT NULL,
    "slot" INTEGER NOT NULL,
    CONSTRAINT "ad_slot_bookings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ad_slot_bookings_space_scopeKey_day_slot_key" ON "ad_slot_bookings"("space", "scopeKey", "day", "slot");
CREATE INDEX "ad_slot_bookings_campaignId_idx" ON "ad_slot_bookings"("campaignId");
ALTER TABLE "ad_slot_bookings" ADD CONSTRAINT "ad_slot_bookings_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ad_clicks" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "productId" TEXT,
    "viewerKey" TEXT NOT NULL,
    "userId" TEXT,
    "valid" BOOLEAN NOT NULL,
    "reason" TEXT,
    "chargedPaise" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ad_clicks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ad_clicks_campaignId_viewerKey_productId_createdAt_idx" ON "ad_clicks"("campaignId", "viewerKey", "productId", "createdAt");
CREATE INDEX "ad_clicks_userId_productId_createdAt_idx" ON "ad_clicks"("userId", "productId", "createdAt");
ALTER TABLE "ad_clicks" ADD CONSTRAINT "ad_clicks_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ad_daily_stats" (
    "campaignId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "slotType" TEXT NOT NULL DEFAULT '',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spendPaise" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "revenuePaise" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ad_daily_stats_pkey" PRIMARY KEY ("campaignId", "day", "slotType")
);
ALTER TABLE "ad_daily_stats" ADD CONSTRAINT "ad_daily_stats_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ad_attributions" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "clickId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "revenuePaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ad_attributions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ad_attributions_orderItemId_key" ON "ad_attributions"("orderItemId");
CREATE INDEX "ad_attributions_campaignId_idx" ON "ad_attributions"("campaignId");
ALTER TABLE "ad_attributions" ADD CONSTRAINT "ad_attributions_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
