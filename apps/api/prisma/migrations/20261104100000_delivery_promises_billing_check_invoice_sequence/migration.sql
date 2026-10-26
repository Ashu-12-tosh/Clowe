-- Delivery promises per seller on each order, the courier's promised date and
-- RTO reason on parcels, a gap-free invoice counter, and the Delhivery billing check.

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "courierPromisedAt" TIMESTAMP(3),
ADD COLUMN     "rtoReason" TEXT;

-- CreateTable
CREATE TABLE "order_seller_promises" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "originPincode" TEXT,
    "destinationPincode" TEXT NOT NULL,
    "deliveryBy" TIMESTAMP(3) NOT NULL,
    "deliveryByLatest" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "tatDays" INTEGER,
    "dispatchDays" INTEGER NOT NULL,
    "freightEstimatePaise" INTEGER,
    "freightZone" TEXT,
    "chargeableGrams" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_seller_promises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "series" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("series","financialYear")
);

-- CreateTable
CREATE TABLE "delhivery_billing_checks" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delhivery_billing_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delhivery_billing_lines" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "awbNumber" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "shipmentId" TEXT,
    "sellerId" TEXT,
    "orderId" TEXT,
    "billedPaise" INTEGER NOT NULL,
    "billedWeightGrams" INTEGER,
    "ledgerPaise" INTEGER,
    "ledgerWeightGrams" INTEGER,
    "differencePaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "adjustmentEntryId" TEXT,
    "adjustedAt" TIMESTAMP(3),
    "adjustedById" TEXT,

    CONSTRAINT "delhivery_billing_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_seller_promises_sellerId_idx" ON "order_seller_promises"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "order_seller_promises_orderId_sellerId_key" ON "order_seller_promises"("orderId", "sellerId");

-- CreateIndex
CREATE INDEX "delhivery_billing_checks_month_idx" ON "delhivery_billing_checks"("month");

-- CreateIndex
CREATE INDEX "delhivery_billing_lines_checkId_status_idx" ON "delhivery_billing_lines"("checkId", "status");

-- CreateIndex
CREATE INDEX "delhivery_billing_lines_awbNumber_idx" ON "delhivery_billing_lines"("awbNumber");

-- AddForeignKey
ALTER TABLE "order_seller_promises" ADD CONSTRAINT "order_seller_promises_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_seller_promises" ADD CONSTRAINT "order_seller_promises_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delhivery_billing_lines" ADD CONSTRAINT "delhivery_billing_lines_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "delhivery_billing_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

