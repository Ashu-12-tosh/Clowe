-- Referral fees by category and price slab (the owner's fee schedule).
ALTER TABLE "categories" ADD COLUMN "referralFeeCategory" TEXT;

CREATE TABLE "referral_fee_schedules" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "referral_fee_schedules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "referral_fee_schedules_version_key" ON "referral_fee_schedules"("version");

CREATE TABLE "referral_fee_rates" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "sheetCategory" TEXT NOT NULL,
    "slabLabel" TEXT NOT NULL,
    "abovePaise" INTEGER NOT NULL,
    "upToPaise" INTEGER,
    "rateBps" INTEGER NOT NULL,
    "benchmarkBps" INTEGER,
    "borrowedFrom" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "referral_fee_rates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "referral_fee_rates_scheduleId_sheetCategory_idx" ON "referral_fee_rates"("scheduleId", "sheetCategory");
ALTER TABLE "referral_fee_rates" ADD CONSTRAINT "referral_fee_rates_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "referral_fee_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
