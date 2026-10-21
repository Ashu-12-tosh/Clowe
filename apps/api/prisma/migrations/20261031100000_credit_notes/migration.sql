-- GST credit notes (CGST Act s.34): issued by the seller when an invoiced line
-- comes back and is refunded. Kept exactly as issued (the document), one per
-- returned line, numbered in the invoice's series.
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_notes_number_key" ON "credit_notes"("number");
CREATE UNIQUE INDEX "credit_notes_orderItemId_key" ON "credit_notes"("orderItemId");
CREATE INDEX "credit_notes_orderId_sellerId_idx" ON "credit_notes"("orderId", "sellerId");
