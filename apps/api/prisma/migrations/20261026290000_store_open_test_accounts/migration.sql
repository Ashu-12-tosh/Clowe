-- Owner's pre-launch switch: accounts an admin marks as test accounts may order while the store is closed.
ALTER TABLE "users" ADD COLUMN "isTestAccount" BOOLEAN NOT NULL DEFAULT false;
