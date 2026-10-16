-- Owner: email from no-reply@cloweshop.com through Hostinger SMTP, queued with retry and a daily cap.
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "kind" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "userId" TEXT,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_outbox_dedupeKey_key" ON "email_outbox"("dedupeKey");
CREATE INDEX "email_outbox_status_nextAttemptAt_idx" ON "email_outbox"("status", "nextAttemptAt");
CREATE INDEX "email_outbox_sentAt_idx" ON "email_outbox"("sentAt");
CREATE INDEX "email_outbox_createdAt_idx" ON "email_outbox"("createdAt");
