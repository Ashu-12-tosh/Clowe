-- When the money was taken, kept when the payment is later refunded. The order
-- page used to derive it as "updatedAt while PAID", so a refund erased it.
ALTER TABLE "payments" ADD COLUMN "paidAt" TIMESTAMP(3);

-- Payments that are PAID now were last updated when they were paid. A payment
-- already marked REFUNDED has no record of when it was paid and stays empty.
UPDATE "payments" SET "paidAt" = "updatedAt" WHERE "status" = 'PAID';
