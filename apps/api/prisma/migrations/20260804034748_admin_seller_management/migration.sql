-- CreateEnum
CREATE TYPE "SellerKycStatus" AS ENUM ('PENDING_DOCS', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED');

-- AlterEnum
ALTER TYPE "SellerStatus" ADD VALUE 'BANNED';

-- AlterTable
ALTER TABLE "seller_profiles" ADD COLUMN     "businessType" TEXT,
ADD COLUMN     "kycReviewedAt" TIMESTAMP(3),
ADD COLUMN     "kycStatus" "SellerKycStatus" NOT NULL DEFAULT 'PENDING_DOCS',
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspensionReason" TEXT;

-- CreateTable
CREATE TABLE "seller_notes" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seller_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seller_notes_sellerId_createdAt_idx" ON "seller_notes"("sellerId", "createdAt");

-- AddForeignKey
ALTER TABLE "seller_notes" ADD CONSTRAINT "seller_notes_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_notes" ADD CONSTRAINT "seller_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
