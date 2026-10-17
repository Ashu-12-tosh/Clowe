-- Failed pickups ("Not Picked") and each seller's pickup slot and working days.
ALTER TABLE "shipments" ADD COLUMN "pickupFailedAt" TIMESTAMP(3),
ADD COLUMN "pickupFailures" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "seller_profiles" ADD COLUMN "pickupSlot" TEXT NOT NULL DEFAULT '11:00',
ADD COLUMN "pickupDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[];
