-- RTO freight stays the seller's: Delhivery's charge for bringing an
-- undelivered parcel back, as its own ledger entry. Nothing is dropped.

-- AlterEnum
ALTER TYPE "SellerLedgerType" ADD VALUE 'RTO_FREIGHT';
