-- The provider's reference id for a verification (Cashfree reference_id). Additive.
ALTER TABLE "seller_kyc_checks" ADD COLUMN "providerRef" TEXT;
