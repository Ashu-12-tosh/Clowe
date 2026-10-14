-- When Delhivery is asked to collect a parcel: one pickup request per pickup
-- address and day, joined by every parcel shipped that day. Nothing is dropped.

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "pickupScheduledFor" TIMESTAMP(3);
