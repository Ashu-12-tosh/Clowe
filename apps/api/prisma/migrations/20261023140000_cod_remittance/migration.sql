-- Delhivery COD remittance reports, matched to parcels by AWB and amount: a
-- matched row makes its parcel's COD lines payable to the seller. Nothing is
-- dropped.


-- CreateTable
CREATE TABLE "cod_remittance_imports" (
    "id" TEXT NOT NULL,
    "uploadedById" TEXT,
    "fileName" TEXT,
    "rowCount" INTEGER NOT NULL,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "mismatched" INTEGER NOT NULL DEFAULT 0,
    "unknown" INTEGER NOT NULL DEFAULT 0,
    "duplicate" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_remittance_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_remittance_rows" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "awbNumber" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "reference" TEXT,
    "remittedOn" TEXT,
    "shipmentId" TEXT,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_remittance_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cod_remittance_imports_createdAt_idx" ON "cod_remittance_imports"("createdAt");

-- CreateIndex
CREATE INDEX "cod_remittance_rows_awbNumber_idx" ON "cod_remittance_rows"("awbNumber");

-- CreateIndex
CREATE INDEX "cod_remittance_rows_importId_idx" ON "cod_remittance_rows"("importId");

-- AddForeignKey
ALTER TABLE "cod_remittance_rows" ADD CONSTRAINT "cod_remittance_rows_importId_fkey" FOREIGN KEY ("importId") REFERENCES "cod_remittance_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

