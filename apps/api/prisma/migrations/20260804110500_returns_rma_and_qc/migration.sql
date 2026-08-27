-- CreateEnum
CREATE TYPE "ReturnResolution" AS ENUM ('REFUND', 'STORE_CREDIT');

-- DropForeignKey
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_returnId_fkey";

-- AlterTable: a refund can now stand on its own (goodwill refunds have no return)
ALTER TABLE "refunds" ADD COLUMN     "issuedByAdminId" TEXT,
ADD COLUMN     "reason" TEXT,
ALTER COLUMN "returnId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "pickedUpAt" TIMESTAMP(3),
ADD COLUMN     "qcNote" TEXT,
ADD COLUMN     "qcPassed" BOOLEAN,
ADD COLUMN     "resolution" "ReturnResolution" NOT NULL DEFAULT 'REFUND';

-- rmaNumber is unique and required, so existing rows are numbered before the
-- constraint goes on: oldest return of each year becomes RMA-<year>-000001.
ALTER TABLE "returns" ADD COLUMN "rmaNumber" TEXT;

WITH numbered AS (
  SELECT id,
         'RMA-' || TO_CHAR("createdAt", 'YYYY') || '-' ||
         LPAD(ROW_NUMBER() OVER (PARTITION BY TO_CHAR("createdAt", 'YYYY') ORDER BY "createdAt")::text, 6, '0') AS rma
  FROM "returns"
)
UPDATE "returns" r SET "rmaNumber" = n.rma FROM numbered n WHERE r.id = n.id;

ALTER TABLE "returns" ALTER COLUMN "rmaNumber" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "returns_rmaNumber_key" ON "returns"("rmaNumber");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_issuedByAdminId_fkey" FOREIGN KEY ("issuedByAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
