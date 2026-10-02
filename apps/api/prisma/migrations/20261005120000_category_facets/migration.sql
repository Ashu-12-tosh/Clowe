-- Filter facets per category: what it adds to, hides from and reorders of its
-- parent's set (see packages/shared/src/facets.ts). NULL = exactly as the parent.
ALTER TABLE "categories" ADD COLUMN "facets" JSONB;
