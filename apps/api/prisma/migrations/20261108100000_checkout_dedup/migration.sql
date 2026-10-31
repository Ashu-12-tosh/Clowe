-- Checkout de-duplication (pre-launch test H1/H2): one cart, one payable
-- order. The browser's key for a checkout attempt (unique per buyer; NULLs
-- do not clash) and a fingerprint of the order's contents.
ALTER TABLE "orders" ADD COLUMN "checkoutKey" TEXT;
ALTER TABLE "orders" ADD COLUMN "checkoutFingerprint" TEXT;
CREATE UNIQUE INDEX "orders_userId_checkoutKey_key" ON "orders"("userId", "checkoutKey");
