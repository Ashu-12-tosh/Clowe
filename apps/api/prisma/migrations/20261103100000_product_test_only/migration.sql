-- Clowe's own payment-test listing: in no list, search or sitemap; open by its
-- direct link; bought only by an account an admin marked as a test account.
ALTER TABLE "products" ADD COLUMN "testOnly" BOOLEAN NOT NULL DEFAULT false;
