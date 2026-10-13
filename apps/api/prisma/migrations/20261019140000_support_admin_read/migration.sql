-- When an admin last opened each conversation, for the support inbox unread counts.
ALTER TABLE "support_tickets" ADD COLUMN "adminReadAt" TIMESTAMP(3);
ALTER TABLE "complaints" ADD COLUMN "adminReadAt" TIMESTAMP(3);
