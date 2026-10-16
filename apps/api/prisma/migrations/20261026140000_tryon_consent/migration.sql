-- AI Try-On consent (Privacy Policy 3): when it was given, and which wording.
ALTER TABLE "users" ADD COLUMN "tryOnConsentAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "tryOnConsentVersion" TEXT;
