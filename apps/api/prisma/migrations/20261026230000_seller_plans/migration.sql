-- Owner's Batch 2: seller plans.
CREATE TYPE "SellerPlanKind" AS ENUM ('FREE', 'GROWTH', 'PRO', 'PREMIUM');

CREATE TABLE "seller_subscriptions" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "plan" "SellerPlanKind" NOT NULL DEFAULT 'FREE',
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "pendingPlan" "SellerPlanKind",
    "graceUntil" TIMESTAMP(3),
    "limitGraceUntil" TIMESTAMP(3),
    "limitNoticeSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "seller_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "seller_subscriptions_sellerId_key" ON "seller_subscriptions"("sellerId");
CREATE INDEX "seller_subscriptions_periodEnd_idx" ON "seller_subscriptions"("periodEnd");
ALTER TABLE "seller_subscriptions" ADD CONSTRAINT "seller_subscriptions_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "products" ADD COLUMN "planHidden" BOOLEAN NOT NULL DEFAULT false;

-- Every existing seller starts on FREE; those already selling keep every
-- product live for 30 days before the FREE limit applies (they are told).
INSERT INTO "seller_subscriptions" ("id", "sellerId", "plan", "limitGraceUntil", "updatedAt")
SELECT 'sub_' || s."id", s."id", 'FREE', now() + INTERVAL '30 days', now() FROM "seller_profiles" s
ON CONFLICT ("sellerId") DO NOTHING;
