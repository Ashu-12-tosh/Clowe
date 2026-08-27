-- CreateEnum
CREATE TYPE "AddressLabel" AS ENUM ('HOME', 'OFFICE', 'OTHER');

-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('STANDARD', 'EXPRESS', 'SAME_DAY');

-- AlterTable
ALTER TABLE "addresses" ADD COLUMN     "label" "AddressLabel" NOT NULL DEFAULT 'HOME';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveryMethod" "DeliveryMethod" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "etaFrom" TIMESTAMP(3),
ADD COLUMN     "etaTo" TIMESTAMP(3),
ADD COLUMN     "giftMessage" TEXT,
ADD COLUMN     "isGift" BOOLEAN NOT NULL DEFAULT false;
