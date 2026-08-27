-- AlterTable
ALTER TABLE "coupons" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "perUserLimit" INTEGER;

