-- Customer Support and Grievance Policy: levels, resolve-by, product complaints routed to the seller.
ALTER TABLE "complaints" ADD COLUMN "level" TEXT NOT NULL DEFAULT 'SUPPORT',
ADD COLUMN "escalatedAt" TIMESTAMP(3),
ADD COLUMN "resolveDueAt" TIMESTAMP(3),
ADD COLUMN "sellerId" TEXT,
ADD COLUMN "sellerDueAt" TIMESTAMP(3),
ADD COLUMN "sellerRespondedAt" TIMESTAMP(3),
ADD COLUMN "breachNotifiedAt" TIMESTAMP(3);

ALTER TABLE "complaints" ADD CONSTRAINT "complaints_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "complaints_sellerId_sellerRespondedAt_idx" ON "complaints"("sellerId", "sellerRespondedAt");

-- Open complaints get the consumer redress date: one month from receipt.
UPDATE "complaints" SET "resolveDueAt" = "createdAt" + INTERVAL '1 month'
WHERE "resolveDueAt" IS NULL AND "status" NOT IN ('RESOLVED', 'CLOSED');
