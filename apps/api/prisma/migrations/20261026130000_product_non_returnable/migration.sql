-- A seller can mark one product "Not returnable" (pierced jewellery, customised
-- or final-sale items); a non-returnable category still wins.
ALTER TABLE "products" ADD COLUMN "nonReturnable" BOOLEAN NOT NULL DEFAULT false;
