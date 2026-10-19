-- PIN lockout with a clear end: after repeated wrong PINs the account pauses
-- PIN sign-in until this time (a correct PIN is refused with that message,
-- never as "wrong"); pinAttempts keeps counting toward the OTP-only lock.
ALTER TABLE "users" ADD COLUMN "pinLockedUntil" TIMESTAMP(3);
