-- Returns that already ended without a refund said REFUND. Only rows with no
-- refund behind them are changed.
UPDATE "returns" SET "resolution" = 'EXCHANGE'
WHERE "replacementOrderId" IS NOT NULL AND "resolution" = 'REFUND'
  AND NOT EXISTS (SELECT 1 FROM "refunds" f WHERE f."returnId" = "returns"."id");

UPDATE "returns" SET "resolution" = 'NONE'
WHERE ("status" = 'REJECTED' OR "sentBackOrderId" IS NOT NULL) AND "resolution" = 'REFUND'
  AND NOT EXISTS (SELECT 1 FROM "refunds" f WHERE f."returnId" = "returns"."id");
