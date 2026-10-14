-- The COD fee is the seller's: Delhivery's charge on a delivered COD parcel,
-- estimated at booking and posted as its own ledger entry. Nothing is dropped.

-- AlterEnum
ALTER TYPE "SellerLedgerType" ADD VALUE 'COD_FEE';

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "codFeePaise" INTEGER,
ADD COLUMN     "estimatedCodFeePaise" INTEGER;
