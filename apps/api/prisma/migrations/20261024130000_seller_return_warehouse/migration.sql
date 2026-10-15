-- Returns go to the seller's return address when set: a second Delhivery
-- warehouse registered there, named here. Nothing is dropped.

-- AlterTable
ALTER TABLE "seller_profiles" ADD COLUMN     "courierReturnWarehouseName" TEXT;
