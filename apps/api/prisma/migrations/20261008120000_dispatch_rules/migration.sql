-- Dispatch rules from settings: a promise (dispatchSlaHours) and a later
-- penalty deadline (lateDispatchPenaltyAfterHours), one penalty per order.

-- Vacation stops the penalty clock; these record for how long.
ALTER TABLE "seller_profiles" ADD COLUMN "vacationStartedAt" TIMESTAMP(3);
ALTER TABLE "seller_profiles" ADD COLUMN "vacationEndedAt" TIMESTAMP(3);

-- A seller already on vacation is paused from now: when it began is unknown.
UPDATE "seller_profiles" SET "vacationStartedAt" = CURRENT_TIMESTAMP WHERE "vacationMode" = true;

-- One late-dispatch penalty (and one waiver) per order and seller.
ALTER TABLE "seller_ledger_entries" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "seller_ledger_entries_idempotencyKey_key" ON "seller_ledger_entries"("idempotencyKey");

-- The single dispatch window is replaced by the two settings above; their
-- defaults (18h and 24h) apply until an admin saves new ones.
DELETE FROM "platform_settings" WHERE key = 'dispatchWindowHours';
