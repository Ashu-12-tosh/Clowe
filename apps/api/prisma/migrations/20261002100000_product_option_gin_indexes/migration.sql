-- GIN indexes on the two JSON columns the filter facets will read.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- The facet SQL in the Filters v2 design walks jsonb_each_text() over the
-- variants and attributes of a base set of product ids and counts values per
-- key; the containment filters it applies ("optionValues" @> '{"color_family":
-- "Blue"}') are what jsonb_path_ops serves. The operator class indexes only
-- the key/value paths, which is all a containment query needs, and is a
-- fraction of the size of the default jsonb_ops. Both are declared in
-- schema.prisma too, so a later `migrate diff` does not try to add them again.
CREATE INDEX "product_variants_optionValues_idx" ON "product_variants" USING GIN ("optionValues" jsonb_path_ops);
CREATE INDEX "products_attributes_idx" ON "products" USING GIN ("attributes" jsonb_path_ops);
