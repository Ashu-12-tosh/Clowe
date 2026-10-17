-- Owner: customers' email with a one-time confirmation link.
ALTER TABLE "users" ADD COLUMN "emailVerifyTokenHash" TEXT;
ALTER TABLE "users" ADD COLUMN "emailVerifySentAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "users_emailVerifyTokenHash_key" ON "users"("emailVerifyTokenHash");
