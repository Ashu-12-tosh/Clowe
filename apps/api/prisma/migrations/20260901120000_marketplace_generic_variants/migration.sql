-- Marketplace: generic variant options, category rules, order-item labels.
-- Assembled from `prisma migrate diff`, with data backfills so existing rows
-- (apparel + electronics seeds, live orders) come out consistent.

-- AlterEnum: general-marketplace return reasons
ALTER TYPE "ReturnReason" ADD VALUE 'DEFECTIVE';
ALTER TYPE "ReturnReason" ADD VALUE 'MISSING_PARTS';
ALTER TYPE "ReturnReason" ADD VALUE 'NOT_AS_DESCRIBED';
ALTER TYPE "ReturnReason" ADD VALUE 'CHANGED_MIND';

-- AlterTable: per-department rules live on the category tree
ALTER TABLE "categories" ADD COLUMN     "attributeSchema" JSONB,
ADD COLUMN     "defaultTaxRatePercent" INTEGER,
ADD COLUMN     "hsnCode" TEXT,
ADD COLUMN     "returnWindowDays" INTEGER,
ADD COLUMN     "sizeGuide" BOOLEAN,
ADD COLUMN     "taxRule" TEXT,
ADD COLUMN     "tryOnEligible" BOOLEAN,
ADD COLUMN     "variantAxes" JSONB;

-- AlterTable: order lines snapshot the variant label + option map
ALTER TABLE "order_items" ADD COLUMN     "optionValues" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "variantLabel" TEXT NOT NULL DEFAULT '';

-- DropIndex: size+colour stops being the identity of a variant (must go before
-- the backfill, which blanks the size cache for non-apparel rows)
DROP INDEX "product_variants_productId_size_color_key";

-- AlterTable: variants are keyed on their option map, not size+colour
ALTER TABLE "product_variants" ADD COLUMN     "label" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "optionsKey" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "size" SET DEFAULT '',
ALTER COLUMN "color" SET DEFAULT '';

-- AlterTable: try-on is opt-in, and only honoured in eligible categories
ALTER TABLE "products" ALTER COLUMN "tryOnEnabled" SET DEFAULT false;

-- Backfill 1: drop the old "One Size" / "Default" placeholders from option maps
UPDATE "product_variants" SET "optionValues" = "optionValues" - 'size'
 WHERE lower(btrim(COALESCE("optionValues"->>'size', ''))) IN ('one size', 'standard', 'default', 'n/a', '-');
UPDATE "product_variants" SET "optionValues" = "optionValues" - 'color'
 WHERE lower(btrim(COALESCE("optionValues"->>'color', ''))) IN ('one size', 'standard', 'default', 'n/a', '-');

-- Backfill 2: pre-marketplace rows only have the columns - fold them into the map
UPDATE "product_variants" v SET "optionValues" = (
  SELECT COALESCE(jsonb_object_agg(k, btrim(val)), '{}'::jsonb)
  FROM (VALUES ('size', v."size"), ('color', v."color")) AS t(k, val)
  WHERE btrim(val) <> '' AND lower(btrim(val)) NOT IN ('one size', 'standard', 'default', 'n/a', '-')
) WHERE v."optionValues" = '{}'::jsonb;

-- Backfill 3: derive the uniqueness key, the label and the display caches
UPDATE "product_variants" v SET
  "optionsKey" = COALESCE((SELECT string_agg(key || '=' || value, '|' ORDER BY key) FROM jsonb_each_text(v."optionValues")), ''),
  "label" = COALESCE((SELECT string_agg(value, ' · ' ORDER BY CASE key WHEN 'color' THEN 0 WHEN 'size' THEN 1 ELSE 2 END, key) FROM jsonb_each_text(v."optionValues")), ''),
  "size" = COALESCE(v."optionValues"->>'size', ''),
  "color" = COALESCE(v."optionValues"->>'color', '');

-- New uniqueness key (the old size+colour one was dropped before the backfill)
CREATE UNIQUE INDEX "product_variants_productId_optionsKey_key" ON "product_variants"("productId", "optionsKey");

-- Backfill 4: order lines take their variant's label + option map
UPDATE "order_items" oi SET "optionValues" = v."optionValues", "variantLabel" = v."label"
  FROM "product_variants" v WHERE v."id" = oi."variantId";

-- Backfill 5: rules for the seeded root categories (children inherit)
UPDATE "categories" SET "variantAxes" = '[{"key":"color","label":"Colour"},{"key":"storage","label":"Storage"},{"key":"ram","label":"RAM"}]'::jsonb, "attributeSchema" = '[{"key":"model_number","label":"Model number","type":"text","required":true},{"key":"warranty","label":"Warranty","type":"text","required":true,"placeholder":"e.g. 1 year manufacturer warranty"},{"key":"in_the_box","label":"In the box","type":"text"},{"key":"power","label":"Power / battery","type":"text"},{"key":"connectivity","label":"Connectivity","type":"text"},{"key":"dimensions","label":"Dimensions","type":"text"},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = false, "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8471', "returnWindowDays" = 10 WHERE "slug" = 'electronics';
UPDATE "categories" SET "variantAxes" = '[{"key":"color","label":"Colour"},{"key":"storage","label":"Storage","values":["64GB","128GB","256GB","512GB"]},{"key":"ram","label":"RAM","values":["4GB","6GB","8GB","12GB"]}]'::jsonb, "attributeSchema" = '[{"key":"model_number","label":"Model number","type":"text","required":true},{"key":"warranty","label":"Warranty","type":"text","required":true,"placeholder":"e.g. 1 year manufacturer warranty"},{"key":"display","label":"Display","type":"text"},{"key":"processor","label":"Processor","type":"text"},{"key":"battery","label":"Battery","type":"text","unit":"mAh"},{"key":"camera","label":"Camera","type":"text"},{"key":"os","label":"Operating system","type":"text"},{"key":"in_the_box","label":"In the box","type":"text"},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = false, "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8517', "returnWindowDays" = 7 WHERE "slug" = 'mobiles';
UPDATE "categories" SET "variantAxes" = '[{"key":"color","label":"Colour"},{"key":"size","label":"Size","values":["XS","S","M","L","XL","XXL"]}]'::jsonb, "attributeSchema" = '[{"key":"fabric","label":"Fabric","type":"text","required":true},{"key":"fit","label":"Fit","type":"select","options":["Slim","Regular","Relaxed","Oversized"]},{"key":"pattern","label":"Pattern","type":"text"},{"key":"sleeve","label":"Sleeve length","type":"text"},{"key":"occasion","label":"Occasion","type":"text"},{"key":"wash_care","label":"Wash care","type":"text"},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true}]'::jsonb, "tryOnEligible" = true, "sizeGuide" = true, "taxRule" = 'APPAREL_SLAB', "defaultTaxRatePercent" = NULL, "hsnCode" = '6109', "returnWindowDays" = 7 WHERE "slug" = 'fashion';
UPDATE "categories" SET "variantAxes" = '[{"key":"color","label":"Colour"},{"key":"capacity","label":"Capacity"}]'::jsonb, "attributeSchema" = '[{"key":"material","label":"Material","type":"text","required":true},{"key":"dimensions","label":"Dimensions","type":"text"},{"key":"set_contents","label":"Set contents","type":"text"},{"key":"care","label":"Care instructions","type":"text"},{"key":"warranty","label":"Warranty","type":"text","required":true,"placeholder":"e.g. 1 year manufacturer warranty"},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = false, "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = NULL, "returnWindowDays" = 7 WHERE "slug" = 'home-kitchen';
UPDATE "categories" SET "variantAxes" = '[{"key":"shade","label":"Shade"},{"key":"volume","label":"Volume / size"}]'::jsonb, "attributeSchema" = '[{"key":"net_quantity","label":"Net quantity","type":"text","required":true},{"key":"skin_type","label":"Skin / hair type","type":"text"},{"key":"formulation","label":"Formulation","type":"text"},{"key":"ingredients","label":"Key ingredients","type":"text"},{"key":"shelf_life","label":"Shelf life","type":"text","required":true},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true},{"key":"manufacturer","label":"Manufacturer / packer","type":"text"}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = false, "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '3304', "returnWindowDays" = 7 WHERE "slug" = 'beauty';
UPDATE "categories" SET "variantAxes" = '[{"key":"format","label":"Format","values":["Paperback","Hardcover"]},{"key":"language","label":"Language"}]'::jsonb, "attributeSchema" = '[{"key":"author","label":"Author","type":"text","required":true},{"key":"publisher","label":"Publisher","type":"text"},{"key":"isbn","label":"ISBN","type":"text","required":true},{"key":"pages","label":"Pages","type":"number"},{"key":"edition","label":"Edition","type":"text"},{"key":"language","label":"Language","type":"text"}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = false, "taxRule" = NULL, "defaultTaxRatePercent" = 0, "hsnCode" = '4901', "returnWindowDays" = 7 WHERE "slug" = 'books';
UPDATE "categories" SET "variantAxes" = '[{"key":"flavour","label":"Flavour"},{"key":"weight","label":"Weight"}]'::jsonb, "attributeSchema" = '[{"key":"net_quantity","label":"Net quantity","type":"text","required":true},{"key":"serving_size","label":"Serving size","type":"text"},{"key":"ingredients","label":"Ingredients","type":"text","required":true},{"key":"shelf_life","label":"Shelf life","type":"text","required":true},{"key":"fssai","label":"FSSAI licence no.","type":"text"},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true},{"key":"manufacturer","label":"Manufacturer / packer","type":"text"}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = false, "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '2106', "returnWindowDays" = 7 WHERE "slug" = 'supplements';
UPDATE "categories" SET "variantAxes" = '[{"key":"color","label":"Colour"},{"key":"size","label":"Size","values":["XS","S","M","L","XL","XXL"]}]'::jsonb, "attributeSchema" = '[{"key":"material","label":"Material","type":"text"},{"key":"suitable_for","label":"Suitable for","type":"text"},{"key":"dimensions","label":"Dimensions / weight","type":"text"},{"key":"warranty","label":"Warranty","type":"text","required":true,"placeholder":"e.g. 1 year manufacturer warranty"},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = true, "taxRule" = NULL, "defaultTaxRatePercent" = 12, "hsnCode" = '9506', "returnWindowDays" = 7 WHERE "slug" = 'sports';
UPDATE "categories" SET "variantAxes" = '[{"key":"platform","label":"Platform","values":["PC","PlayStation 5","Xbox Series X","Nintendo Switch"]},{"key":"edition","label":"Edition"},{"key":"color","label":"Colour"}]'::jsonb, "attributeSchema" = '[{"key":"genre","label":"Genre","type":"text"},{"key":"region","label":"Region","type":"text"},{"key":"warranty","label":"Warranty","type":"text","required":true,"placeholder":"e.g. 1 year manufacturer warranty"},{"key":"in_the_box","label":"In the box","type":"text"},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = false, "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = NULL, "returnWindowDays" = 7 WHERE "slug" = 'gaming';
UPDATE "categories" SET "variantAxes" = '[{"key":"weight","label":"Weight / pack"}]'::jsonb, "attributeSchema" = '[{"key":"net_quantity","label":"Net quantity","type":"text","required":true},{"key":"shelf_life","label":"Shelf life / best before","type":"text","required":true},{"key":"ingredients","label":"Ingredients","type":"text"},{"key":"fssai","label":"FSSAI licence no.","type":"text"},{"key":"veg","label":"Vegetarian","type":"select","options":["Veg","Non-veg","N/A"]},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true},{"key":"manufacturer","label":"Manufacturer / packer","type":"text"}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = false, "taxRule" = NULL, "defaultTaxRatePercent" = 5, "hsnCode" = NULL, "returnWindowDays" = 2 WHERE "slug" = 'grocery';
UPDATE "categories" SET "variantAxes" = '[{"key":"color","label":"Colour"},{"key":"size","label":"Size / age"}]'::jsonb, "attributeSchema" = '[{"key":"age_group","label":"Age group","type":"text","required":true},{"key":"material","label":"Material","type":"text"},{"key":"safety","label":"Safety certification","type":"text"},{"key":"battery_required","label":"Batteries required","type":"select","options":["No","Yes - included","Yes - not included"]},{"key":"country_of_origin","label":"Country of origin","type":"text","required":true},{"key":"manufacturer","label":"Manufacturer / packer","type":"text"}]'::jsonb, "tryOnEligible" = false, "sizeGuide" = false, "taxRule" = NULL, "defaultTaxRatePercent" = 12, "hsnCode" = '9503', "returnWindowDays" = 7 WHERE "slug" = 'toys-kids';

-- Backfill 6: try-on stays on only where the category allows it
WITH RECURSIVE tree AS (
  SELECT id, id AS root_id FROM "categories" WHERE "parentId" IS NULL
  UNION ALL
  SELECT c.id, t.root_id FROM "categories" c JOIN tree t ON c."parentId" = t.id
)
UPDATE "products" p SET "tryOnEnabled" = false
  FROM tree JOIN "categories" r ON r.id = tree.root_id
  WHERE tree.id = p."categoryId" AND COALESCE(r."tryOnEligible", false) = false;
