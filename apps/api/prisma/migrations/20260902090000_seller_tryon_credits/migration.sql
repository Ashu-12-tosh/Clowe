-- Seller AI Try-On credits: pool, per-product caps, ledger, launch grant.
ALTER TABLE "seller_profiles" ADD COLUMN "tryOnCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "tryOnFreeGrant" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "products" ADD COLUMN "tryOnLimit" INTEGER,
ADD COLUMN "tryOnUsed" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "tryon_credit_ledger" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tryon_credit_ledger_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tryon_credit_ledger_sellerId_createdAt_idx" ON "tryon_credit_ledger"("sellerId", "createdAt");
ALTER TABLE "tryon_credit_ledger" ADD CONSTRAINT "tryon_credit_ledger_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Launch offer: the first 100 sellers (by signup date) get 50 free try-ons.
WITH first_hundred AS (
  SELECT id FROM "seller_profiles" ORDER BY "createdAt" ASC LIMIT 100
)
UPDATE "seller_profiles" SET "tryOnCredits" = "tryOnCredits" + 50, "tryOnFreeGrant" = true
WHERE id IN (SELECT id FROM first_hundred);

INSERT INTO "tryon_credit_ledger" ("id", "sellerId", "delta", "reason", "note")
SELECT 'tcl' || substr(md5(random()::text || id), 1, 21), id, 50, 'FREE_GRANT', 'Early-seller launch offer'
FROM "seller_profiles" WHERE "tryOnFreeGrant" = true;

-- Historical interest: count past successful runs into each product's counter.
UPDATE "products" p SET "tryOnUsed" = s.cnt
FROM (SELECT "productId", count(*) AS cnt FROM "tryon_history" WHERE status = 'SUCCESS' GROUP BY 1) s
WHERE s."productId" = p.id;
