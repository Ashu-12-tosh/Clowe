-- Every SMS OTP send attempt and the panel's answer, kept across deploys.
-- Never the code, the API key or the full number.
CREATE TABLE "otp_send_logs" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phoneMasked" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "reason" TEXT,
    "httpStatus" INTEGER,
    "panelStatus" TEXT,
    "panelMessage" TEXT,
    "messageId" TEXT,
    "detail" TEXT,
    "durationMs" INTEGER NOT NULL,

    CONSTRAINT "otp_send_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "otp_send_logs_createdAt_idx" ON "otp_send_logs"("createdAt");
CREATE INDEX "otp_send_logs_phoneMasked_createdAt_idx" ON "otp_send_logs"("phoneMasked", "createdAt");
