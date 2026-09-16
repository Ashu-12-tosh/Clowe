-- What shoppers searched for, in aggregate.
--
-- Written by hand rather than generated. `prisma migrate diff` cannot express
-- the GIN index or the GENERATED ALWAYS expression on products."searchVector",
-- so it reads them as drift and emits a DROP for both — which would silently
-- turn off full-text search. Anything touching those objects belongs in a
-- hand-written migration; see 20260914120000_product_search_fts.
--
-- Additive and reversible: one new table, nothing existing is altered.

CREATE TABLE "search_queries" (
    "id" TEXT NOT NULL,
    -- Exactly what was typed. The only field that could carry something
    -- personal, and the one the feature cannot work without: improving the
    -- synonym map means reading the words people actually used.
    "query" TEXT NOT NULL,
    -- Lowercased and whitespace-collapsed; identical searches group on this.
    "normalized" TEXT NOT NULL,
    -- What the parser made of it, so a zero-result row stays diagnosable even
    -- after the parser itself has changed.
    "parsedFilters" JSONB,
    "resultCount" INTEGER NOT NULL,
    -- fts | trigram | filters-only | none
    "strategy" TEXT NOT NULL,
    "relaxed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_queries_pkey" PRIMARY KEY ("id")
);

-- Grouping identical searches together.
CREATE INDEX "search_queries_normalized_idx" ON "search_queries"("normalized");
-- The admin view: zero-result rows, newest first.
CREATE INDEX "search_queries_resultCount_createdAt_idx" ON "search_queries"("resultCount", "createdAt");
-- Retention sweeps delete by age.
CREATE INDEX "search_queries_createdAt_idx" ON "search_queries"("createdAt");

-- --------------------------------------------------------------------------
-- Down migration (Prisma does not run this; kept so a rollback is one paste)
-- --------------------------------------------------------------------------
-- DROP TABLE IF EXISTS "search_queries";
