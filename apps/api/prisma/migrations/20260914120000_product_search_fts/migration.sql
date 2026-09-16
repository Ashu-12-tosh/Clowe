-- Full-text + fuzzy search for the storefront.
--
-- Before this, `q` ran `title ILIKE '%...%' OR brand ILIKE ... OR description
-- ILIKE ...`: a sequential scan, no ranking, no typo tolerance, and it matched
-- on substrings so "phone" also returned every pair of headphones.
--
-- Additive and reversible: nothing existing is altered or dropped, and the
-- down-migration at the bottom of this file removes everything it adds.

-- --------------------------------------------------------------------------
-- Extensions
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- unaccent is not used by the vector below (the 'english' config is enough for
-- this catalog) but is installed alongside so accent-insensitive matching can
-- be switched on later without another extension migration on a live database.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- --------------------------------------------------------------------------
-- Immutable helper
-- --------------------------------------------------------------------------
-- A generated column may only use IMMUTABLE expressions. array_to_string is
-- marked STABLE because it is generic over element types, and some types
-- render differently depending on session settings (DateStyle, for instance).
-- Restricted to text[] it is genuinely deterministic, so this thin wrapper can
-- honestly claim IMMUTABLE.
CREATE OR REPLACE FUNCTION clowe_text_array_to_string(text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$ SELECT array_to_string($1, ' ') $$;

-- --------------------------------------------------------------------------
-- Weighted search vector
-- --------------------------------------------------------------------------
-- A title match should beat a description match, so the fields are weighted:
--   A title   B brand   C tags   D attributes + description
--
-- The category name is deliberately NOT in here. A generated column cannot
-- read another table, and the alternatives (a denormalised column kept in step
-- by triggers on both products and categories) buy little: a typed category
-- name is already recognised by the query parser and turned into a structured
-- category signal, which ranks better than a text match ever would.
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("brand", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(clowe_text_array_to_string("tags"), '')), 'C') ||
    setweight(to_tsvector('english', coalesce("attributes"::text, '')), 'D') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS "products_search_vector_idx"
  ON "products" USING GIN ("searchVector");

-- --------------------------------------------------------------------------
-- Trigram indexes for typo tolerance
-- --------------------------------------------------------------------------
-- Full-text search matches whole lexemes, so "smasung" finds nothing at all.
-- Trigram similarity is the fallback that still reaches "Samsung". Indexed on
-- lower() because every comparison the search endpoint makes is lowercased.
CREATE INDEX IF NOT EXISTS "products_title_trgm_idx"
  ON "products" USING GIN (lower("title") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "products_brand_trgm_idx"
  ON "products" USING GIN (lower(coalesce("brand", '')) gin_trgm_ops);

-- Brand names are searched directly when building suggestions.
CREATE INDEX IF NOT EXISTS "brands_name_trgm_idx"
  ON "brands" USING GIN (lower("name") gin_trgm_ops);

-- --------------------------------------------------------------------------
-- Down migration (Prisma does not run this; kept so a rollback is one paste)
-- --------------------------------------------------------------------------
-- DROP INDEX IF EXISTS "brands_name_trgm_idx";
-- DROP INDEX IF EXISTS "products_brand_trgm_idx";
-- DROP INDEX IF EXISTS "products_title_trgm_idx";
-- DROP INDEX IF EXISTS "products_search_vector_idx";
-- ALTER TABLE "products" DROP COLUMN IF EXISTS "searchVector";
-- DROP FUNCTION IF EXISTS clowe_text_array_to_string(text[]);
-- -- pg_trgm and unaccent are left installed: other objects may come to depend
-- -- on them, and an unused extension costs nothing.
