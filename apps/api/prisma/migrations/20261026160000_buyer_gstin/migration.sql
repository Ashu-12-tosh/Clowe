-- A buyer's GSTIN for a business purchase: given at checkout, printed on the invoice.
ALTER TABLE "orders" ADD COLUMN "buyerGstin" TEXT;
