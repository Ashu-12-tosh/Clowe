-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pinAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pinHash" TEXT;
