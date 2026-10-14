-- Sellers pay Delhivery's actual forward freight per parcel instead of a flat
-- fee per line: posted on delivery, re-priced as its own entry if the charged
-- weight changes. Nothing is dropped. (Postgres 16 adds several enum values in
-- one migration.)

-- AlterEnum
ALTER TYPE "SellerLedgerType" ADD VALUE 'FORWARD_FREIGHT';
ALTER TYPE "SellerLedgerType" ADD VALUE 'FREIGHT_ADJUSTMENT';

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "freightWeightGrams" INTEGER;
