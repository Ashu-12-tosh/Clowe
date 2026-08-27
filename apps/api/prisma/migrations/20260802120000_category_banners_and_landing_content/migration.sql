-- AlterTable
ALTER TABLE "categories" DROP COLUMN "bannerEyebrow",
DROP COLUMN "bannerSubtitle",
DROP COLUMN "bannerTitle",
DROP COLUMN "bannerUrl",
ADD COLUMN     "features" JSONB,
ADD COLUMN     "highlights" JSONB,
ADD COLUMN     "tileShape" TEXT NOT NULL DEFAULT 'square';

-- CreateTable
CREATE TABLE "category_banners" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "eyebrow" TEXT,
    "headline" TEXT NOT NULL,
    "highlight" TEXT,
    "subtext" TEXT,
    "imageUrl" TEXT,
    "primaryLabel" TEXT NOT NULL DEFAULT 'Shop Now',
    "primaryHref" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_banners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "category_banners_categoryId_isActive_sortOrder_idx" ON "category_banners"("categoryId", "isActive", "sortOrder");

-- AddForeignKey
ALTER TABLE "category_banners" ADD CONSTRAINT "category_banners_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

