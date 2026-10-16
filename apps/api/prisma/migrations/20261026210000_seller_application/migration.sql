-- Seller application: Vendor Terms acceptance, the 2.1 documents, requests for more information.
ALTER TYPE "AssetPurpose" ADD VALUE 'SELLER_DOCUMENT';

ALTER TABLE "seller_profiles" ADD COLUMN "applicationSubmittedAt" TIMESTAMP(3),
ADD COLUMN "constitutionDoc" TEXT,
ADD COLUMN "cancelledChequeDoc" TEXT,
ADD COLUMN "signatoryKycDoc" TEXT,
ADD COLUMN "brandAuthorisationDoc" TEXT,
ADD COLUMN "infoRequest" TEXT,
ADD COLUMN "infoRequestedAt" TIMESTAMP(3),
ADD COLUMN "vendorTermsVersion" TEXT,
ADD COLUMN "vendorTermsAcceptedAt" TIMESTAMP(3);

CREATE TABLE "seller_terms_acceptances" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "seller_terms_acceptances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "seller_terms_acceptances_sellerId_acceptedAt_idx" ON "seller_terms_acceptances"("sellerId", "acceptedAt");
ALTER TABLE "seller_terms_acceptances" ADD CONSTRAINT "seller_terms_acceptances_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
