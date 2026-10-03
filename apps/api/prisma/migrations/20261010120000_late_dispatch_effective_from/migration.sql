-- The per-order late-dispatch penalty applies to orders placed from now on.
-- Without this, the first run of the penalty sweep after deploy would charge
-- every order already more than 24 hours late. CURRENT_TIMESTAMP is the
-- moment this migration runs; stored as an ISO string, as the app reads it.
INSERT INTO "platform_settings" (key, value, "updatedAt")
VALUES (
  'lateDispatchPenaltyEffectiveFrom',
  to_jsonb(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  CURRENT_TIMESTAMP
)
ON CONFLICT (key) DO NOTHING;
