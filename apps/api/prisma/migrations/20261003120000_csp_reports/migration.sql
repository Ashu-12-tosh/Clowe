-- Grouped Content-Security-Policy violation reports.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Additive only: a new table nothing else references.
CREATE TABLE "csp_reports" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "directive" TEXT NOT NULL,
    "blocked" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "sample" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "csp_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "csp_reports_fingerprint_key" ON "csp_reports"("fingerprint");
CREATE INDEX "csp_reports_lastSeenAt_idx" ON "csp_reports"("lastSeenAt");
