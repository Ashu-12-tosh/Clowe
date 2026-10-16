-- Clowe's monthly tax invoice to each seller (owner's Batch 2).
CREATE TABLE "seller_tax_invoices" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "document" JSONB NOT NULL,
    CONSTRAINT "seller_tax_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "seller_tax_invoices_number_key" ON "seller_tax_invoices"("number");
CREATE UNIQUE INDEX "seller_tax_invoices_sellerId_month_key" ON "seller_tax_invoices"("sellerId", "month");
ALTER TABLE "seller_tax_invoices" ADD CONSTRAINT "seller_tax_invoices_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
