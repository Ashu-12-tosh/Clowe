-- Shipping Policy: zone estimate from dispatch, delivery attempts, lost in transit.
ALTER TABLE "shipments" ADD COLUMN "etaFrom" TIMESTAMP(3),
ADD COLUMN "etaTo" TIMESTAMP(3),
ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lostFlaggedAt" TIMESTAMP(3),
ADD COLUMN "lostChoice" TEXT,
ADD COLUMN "lostChoiceAt" TIMESTAMP(3);

-- A free replacement line points at the line it replaces.
ALTER TABLE "order_items" ADD COLUMN "replacementOfId" TEXT;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_replacementOfId_fkey" FOREIGN KEY ("replacementOfId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "order_items_replacementOfId_idx" ON "order_items"("replacementOfId");
