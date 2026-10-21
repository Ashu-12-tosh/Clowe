-- How a return ended: an exchange, or nothing paid (pre-launch audit L6).
-- New enum values must be committed before they are used, so the backfill is
-- the next migration.
ALTER TYPE "ReturnResolution" ADD VALUE IF NOT EXISTS 'EXCHANGE';
ALTER TYPE "ReturnResolution" ADD VALUE IF NOT EXISTS 'NONE';
