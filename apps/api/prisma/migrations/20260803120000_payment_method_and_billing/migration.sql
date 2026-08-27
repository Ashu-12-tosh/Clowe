-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "billCity" TEXT,
ADD COLUMN     "billLine1" TEXT,
ADD COLUMN     "billLine2" TEXT,
ADD COLUMN     "billName" TEXT,
ADD COLUMN     "billPincode" TEXT,
ADD COLUMN     "billState" TEXT,
ADD COLUMN     "paymentMethod" TEXT NOT NULL DEFAULT 'UPI';

