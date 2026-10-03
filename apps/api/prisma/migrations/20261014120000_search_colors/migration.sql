-- Colours in the search index, so "black" and "red shirt" match.
--
-- A product's colours live on its variants (color, and optionValues.color /
-- .color_family: "Navy" in the "Blue" family). A generated column cannot read
-- another table, so the names are gathered into products."searchColors" by a
-- trigger on product_variants — whichever path writes a variant (the seller
-- form, a revision approval, a seed, a backfill) — and the search vector
-- reads that column like any other.

ALTER TABLE "products" ADD COLUMN "searchColors" TEXT NOT NULL DEFAULT '';

-- Every distinct colour name and family a product's variants carry.
CREATE OR REPLACE FUNCTION clowe_refresh_search_colors(pid text)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE "products" SET "searchColors" = coalesce((
    SELECT string_agg(DISTINCT c, ' ' ORDER BY c)
    FROM (
      SELECT nullif(trim(v."color"), '') AS c FROM "product_variants" v WHERE v."productId" = pid
      UNION
      SELECT nullif(trim(v."optionValues"->>'color'), '') FROM "product_variants" v WHERE v."productId" = pid
      UNION
      SELECT nullif(trim(v."optionValues"->>'color_family'), '') FROM "product_variants" v WHERE v."productId" = pid
    ) colours
    WHERE c IS NOT NULL
  ), '')
  WHERE id = pid;
$$;

CREATE OR REPLACE FUNCTION clowe_variant_search_colors()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM clowe_refresh_search_colors(OLD."productId");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM clowe_refresh_search_colors(NEW."productId");
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "product_variants_search_colors"
AFTER INSERT OR DELETE OR UPDATE OF "color", "optionValues", "productId" ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION clowe_variant_search_colors();

-- The search vector, rebuilt with the colours at the weight of tags:
--   A title   B brand   C tags + colours   D attributes + description
DROP INDEX IF EXISTS "products_search_vector_idx";
ALTER TABLE "products" DROP COLUMN IF EXISTS "searchVector";
ALTER TABLE "products"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("brand", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(clowe_text_array_to_string("tags"), '')), 'C') ||
    setweight(to_tsvector('english', coalesce("searchColors", '')), 'C') ||
    setweight(to_tsvector('english', coalesce("attributes"::text, '')), 'D') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'D')
  ) STORED;
CREATE INDEX "products_search_vector_idx" ON "products" USING GIN ("searchVector");

-- Colours for every product already listed.
SELECT clowe_refresh_search_colors(id) FROM "products";
