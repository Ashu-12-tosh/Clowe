-- Owner's Batch 2: Clowe's charges, the Seller Wallet's advertising credit, fee snapshots per line.
ALTER TYPE "SellerLedgerType" ADD VALUE 'HANDLING_FEE';
ALTER TYPE "SellerLedgerType" ADD VALUE 'CLOWE_FEE_GST';
ALTER TYPE "SellerLedgerType" ADD VALUE 'ADMIN_PENALTY';
ALTER TYPE "SellerLedgerType" ADD VALUE 'SUBSCRIPTION_FEE';
ALTER TYPE "SellerLedgerType" ADD VALUE 'AD_SPEND';
ALTER TYPE "SellerLedgerType" ADD VALUE 'SPONSORSHIP_FEE';
ALTER TYPE "SellerLedgerType" ADD VALUE 'TRYON_CREDITS';
ALTER TYPE "SellerLedgerType" ADD VALUE 'AD_CREDIT_GRANT';
ALTER TYPE "SellerLedgerBucket" ADD VALUE 'AD_CREDIT';

ALTER TABLE "seller_ledger_entries" ADD COLUMN "chargeType" TEXT;
ALTER TABLE "order_items" ADD COLUMN "feeModel" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "feeRates" JSONB;
-- Every category starts at the 2% referral fee.
ALTER TABLE "categories" ADD COLUMN "referralPercent" DOUBLE PRECISION NOT NULL DEFAULT 2;
ALTER TABLE "seller_profiles" ADD COLUMN "vip" BOOLEAN NOT NULL DEFAULT false;
