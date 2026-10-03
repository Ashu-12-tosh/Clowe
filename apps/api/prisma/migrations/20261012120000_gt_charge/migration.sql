-- The goods transfer (GT) charge: a fixed fee per unit, posted on delivery
-- like the closing fee. Its amount is a platform setting (gtChargePaise).
ALTER TYPE "SellerLedgerType" ADD VALUE 'GT_CHARGE';
