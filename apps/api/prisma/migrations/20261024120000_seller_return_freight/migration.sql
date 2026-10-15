-- Return pickup freight is the seller's: Delhivery's charge for collecting a
-- customer return, as its own ledger entry. Nothing is dropped.

-- AlterEnum
ALTER TYPE "SellerLedgerType" ADD VALUE 'RETURN_FREIGHT';
