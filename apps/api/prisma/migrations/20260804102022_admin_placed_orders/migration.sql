-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "adminNote" TEXT,
ADD COLUMN     "placedByAdminId" TEXT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_placedByAdminId_fkey" FOREIGN KEY ("placedByAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
