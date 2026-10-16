-- Owner's Batch 2: try-on credits in lots (expiry), monthly pack renewal, out-of-credit notice.
ALTER TABLE "seller_profiles" ADD COLUMN "tryOnPackRenewCredits" INTEGER;
ALTER TABLE "seller_profiles" ADD COLUMN "tryOnPackRenewAt" TIMESTAMP(3);
ALTER TABLE "seller_profiles" ADD COLUMN "tryOnZeroNotifiedAt" TIMESTAMP(3);

CREATE TABLE "tryon_credit_lots" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tryon_credit_lots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tryon_credit_lots_sellerId_remaining_idx" ON "tryon_credit_lots"("sellerId", "remaining");
CREATE INDEX "tryon_credit_lots_expiresAt_idx" ON "tryon_credit_lots"("expiresAt");
ALTER TABLE "tryon_credit_lots" ADD CONSTRAINT "tryon_credit_lots_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Credits sellers already hold become one lot each that never expires.
INSERT INTO "tryon_credit_lots" ("id", "sellerId", "source", "credits", "remaining", "expiresAt")
SELECT 'legacy_' || "id", "id", 'LEGACY', "tryOnCredits", "tryOnCredits", NULL
FROM "seller_profiles" WHERE "tryOnCredits" > 0;
