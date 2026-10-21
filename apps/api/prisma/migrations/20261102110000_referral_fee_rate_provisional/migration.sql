-- A rate the owner set for a gap in the sheet, marked to be confirmed.
ALTER TABLE "referral_fee_rates" ADD COLUMN "provisional" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "referral_fee_rates" ADD COLUMN "note" TEXT;
