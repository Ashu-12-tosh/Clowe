-- Non-returnable categories: a per-category switch (null = as the parent),
-- fixed on each order line at checkout like the return window.
ALTER TABLE "categories" ADD COLUMN "returnable" BOOLEAN;
ALTER TABLE "order_items" ADD COLUMN "returnable" BOOLEAN;

-- Cash on Delivery return refunds: where the buyer wants the money sent,
-- encrypted, for an admin to pay by hand.
CREATE TYPE "CodRefundMethod" AS ENUM ('UPI', 'BANK');

CREATE TABLE "cod_refund_accounts" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "method" "CodRefundMethod" NOT NULL,
    "last4" TEXT NOT NULL,
    "cipher" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_refund_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cod_refund_accounts_returnId_key" ON "cod_refund_accounts"("returnId");

ALTER TABLE "cod_refund_accounts" ADD CONSTRAINT "cod_refund_accounts_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
