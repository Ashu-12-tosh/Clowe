-- AlterTable
ALTER TABLE "users" ADD COLUMN     "wishlistShareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_wishlistShareToken_key" ON "users"("wishlistShareToken");

