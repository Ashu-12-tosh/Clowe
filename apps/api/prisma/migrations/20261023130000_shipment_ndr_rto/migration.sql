-- Failed deliveries (what was asked of Delhivery) and parcels back with the
-- seller (how they came back). Nothing is dropped.

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "ndrAction" TEXT,
ADD COLUMN     "ndrActionAt" TIMESTAMP(3),
ADD COLUMN     "ndrRequestId" TEXT,
ADD COLUMN     "rtoReceivedAt" TIMESTAMP(3),
ADD COLUMN     "rtoReceivedCondition" TEXT;
