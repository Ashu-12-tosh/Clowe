-- Shipments with the courier (Delhivery): one per order and seller (or a
-- return pickup), their scans, each seller's registered pickup warehouse, the
-- RTO line statuses and a per-customer RTO count. Nothing is dropped.

-- CreateEnum
CREATE TYPE "ShipmentKind" AS ENUM ('FORWARD', 'REVERSE');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('CREATED', 'PICKUP_REQUESTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED', 'RTO_IN_TRANSIT', 'RTO_DELIVERED', 'CANCELLED', 'LOST');

-- CreateEnum
CREATE TYPE "CourierWarehouseStatus" AS ENUM ('NONE', 'PENDING', 'ACTIVE', 'FAILED');

-- AlterEnum: a parcel that could not be delivered, on its way back / back with the seller.
ALTER TYPE "OrderStatus" ADD VALUE 'RTO_IN_TRANSIT';
ALTER TYPE "OrderStatus" ADD VALUE 'RTO_DELIVERED';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "shipmentId" TEXT;

-- AlterTable
ALTER TABLE "seller_profiles" ADD COLUMN     "courierWarehouseAddressHash" TEXT,
ADD COLUMN     "courierWarehouseError" TEXT,
ADD COLUMN     "courierWarehouseName" TEXT,
ADD COLUMN     "courierWarehouseStatus" "CourierWarehouseStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "courierWarehouseSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "rtoCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "kind" "ShipmentKind" NOT NULL DEFAULT 'FORWARD',
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "returnId" TEXT,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "awbNumber" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'SURFACE',
    "paymentType" TEXT NOT NULL,
    "codAmountPaise" INTEGER NOT NULL DEFAULT 0,
    "weightGrams" INTEGER NOT NULL,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "chargedWeightGrams" INTEGER,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "statusText" TEXT,
    "lastScanAt" TIMESTAMP(3),
    "pickupRequestId" TEXT,
    "pickupRequestedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "rtoInitiatedAt" TIMESTAMP(3),
    "rtoDeliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "labelSize" TEXT,
    "estimatedFreightPaise" INTEGER,
    "finalFreightPaise" INTEGER,
    "rtoFreightPaise" INTEGER,
    "codRemittedAt" TIMESTAMP(3),
    "codRemittanceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "statusType" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "location" TEXT,
    "instructions" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_returnId_key" ON "shipments"("returnId");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_awbNumber_key" ON "shipments"("awbNumber");

-- CreateIndex
CREATE INDEX "shipments_orderId_sellerId_idx" ON "shipments"("orderId", "sellerId");

-- CreateIndex
CREATE INDEX "shipments_sellerId_status_idx" ON "shipments"("sellerId", "status");

-- CreateIndex
CREATE INDEX "shipments_status_lastScanAt_idx" ON "shipments"("status", "lastScanAt");

-- CreateIndex
CREATE INDEX "shipment_events_shipmentId_at_idx" ON "shipment_events"("shipmentId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_events_shipmentId_at_status_code_key" ON "shipment_events"("shipmentId", "at", "status", "code");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

