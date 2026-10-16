-- Return Policy claims: reasons, evidence, remedy, latent defect, self-ship, QC outcome.
ALTER TYPE "ReturnReason" ADD VALUE 'COUNTERFEIT';
ALTER TYPE "AssetPurpose" ADD VALUE 'RETURN_VIDEO';

ALTER TABLE "returns" ADD COLUMN "rules" TEXT NOT NULL DEFAULT 'LEGACY',
ADD COLUMN "remedy" TEXT,
ADD COLUMN "tagPhotos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "packagingPhotos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "unboxingVideo" TEXT,
ADD COLUMN "latentNoticedAt" TIMESTAMP(3),
ADD COLUMN "replacementOrderId" TEXT,
ADD COLUMN "sentBackOrderId" TEXT,
ADD COLUMN "selfShip" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "selfShipReceipt" TEXT,
ADD COLUMN "selfShipCostPaise" INTEGER,
ADD COLUMN "selfShipReimbursedPaise" INTEGER,
ADD COLUMN "selfShipReimbursedAt" TIMESTAMP(3),
ADD COLUMN "selfShipReimburseRef" TEXT;

ALTER TABLE "users" ADD COLUMN "claimsReviewAt" TIMESTAMP(3),
ADD COLUMN "claimsReviewNote" TEXT;

-- The moment the new claim rules start: this migration runs at the deploy.
-- Items delivered before it keep the old return rules.
INSERT INTO "platform_settings" ("key", "value", "updatedAt")
VALUES ('claimRulesFrom', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), now())
ON CONFLICT ("key") DO NOTHING;
