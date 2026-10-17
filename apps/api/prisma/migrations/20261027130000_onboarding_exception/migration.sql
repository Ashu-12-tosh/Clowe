-- Owner: an admin's onboarding exception per seller, until the store opens for orders.
ALTER TABLE "seller_profiles" ADD COLUMN "onboardingException" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "seller_profiles" ADD COLUMN "onboardingExceptionReason" TEXT;
ALTER TABLE "seller_profiles" ADD COLUMN "onboardingExceptionUntil" TIMESTAMP(3);
ALTER TABLE "seller_profiles" ADD COLUMN "onboardingExceptionSetAt" TIMESTAMP(3);
ALTER TABLE "seller_profiles" ADD COLUMN "onboardingExceptionSetBy" TEXT;
