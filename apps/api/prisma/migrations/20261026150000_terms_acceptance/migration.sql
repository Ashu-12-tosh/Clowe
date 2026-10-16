-- The Terms and Privacy Policy version a person accepted at sign-in, and when.
ALTER TABLE "users" ADD COLUMN "termsVersion" TEXT;
ALTER TABLE "users" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
