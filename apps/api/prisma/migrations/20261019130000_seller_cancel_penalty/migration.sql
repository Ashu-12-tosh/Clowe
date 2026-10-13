-- A seller who cancels their part of an order is charged a penalty, once per
-- order, on orders placed from now on (CURRENT_TIMESTAMP is when this runs;
-- stored as an ISO string, as the app reads it). Never when the buyer or an
-- admin cancels.
ALTER TYPE "SellerLedgerType" ADD VALUE IF NOT EXISTS 'SELLER_CANCEL_PENALTY';

INSERT INTO "platform_settings" (key, value, "updatedAt")
VALUES (
  'sellerCancelPenaltyEffectiveFrom',
  to_jsonb(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  CURRENT_TIMESTAMP
)
ON CONFLICT (key) DO NOTHING;
