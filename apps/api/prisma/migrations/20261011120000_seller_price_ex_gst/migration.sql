-- Sellers enter their price BEFORE GST. The existing columns stay the
-- buyer's GST-inclusive price, untouched; these hold the seller's number.
-- Existing rows are filled by prisma/backfillSellerPrices.ts (dry run, then
-- --apply), which needs each category's GST rule; until then the app derives
-- them from the buyer price, so no buyer price changes either way.
ALTER TABLE "product_variants" ADD COLUMN "sellerPricePaise" INTEGER;
ALTER TABLE "product_variants" ADD COLUMN "sellerMrpPaise" INTEGER;
