-- Each order line keeps the GST rate it was sold at, so a later GST change
-- (the owner's flat 18%) never rewrites the tax on a past sale.
ALTER TABLE "order_items" ADD COLUMN "gstRatePercent" INTEGER;

-- Lines sold before this migration: the rate the rules in force gave them,
-- worked out as the app did (gstRateForInclusive): the nearest category up
-- the tree that sets a rule; for the value slab, the merit rate when the unit
-- price at that rate is at or under the threshold, else the standard rate;
-- else the category rate, else the standard rate. The saved GST settings
-- apply, else the defaults they have always had (5%, 18%, ₹2,500).
WITH RECURSIVE chain AS (
  SELECT id AS leaf, "parentId", "taxRule", "defaultTaxRatePercent", 0 AS depth
  FROM "categories"
  UNION ALL
  SELECT chain.leaf, c."parentId", c."taxRule", c."defaultTaxRatePercent", chain.depth + 1
  FROM chain
  JOIN "categories" c ON c.id = chain."parentId"
  WHERE chain."taxRule" IS NULL AND chain."defaultTaxRatePercent" IS NULL
),
tax AS (
  SELECT DISTINCT ON (leaf) leaf, "taxRule", "defaultTaxRatePercent"
  FROM chain
  WHERE "taxRule" IS NOT NULL OR "defaultTaxRatePercent" IS NOT NULL
  ORDER BY leaf, depth
),
gst AS (
  SELECT
    COALESCE((SELECT round((value #>> '{}')::numeric)::int FROM "platform_settings" WHERE key = 'gstMeritPercent'), 5) AS merit,
    COALESCE((SELECT round((value #>> '{}')::numeric)::int FROM "platform_settings" WHERE key = 'gstStandardPercent'), 18) AS standard,
    COALESCE((SELECT round((value #>> '{}')::numeric)::bigint FROM "platform_settings" WHERE key = 'gstValueSlabThresholdPaise'), 250000) AS threshold
)
UPDATE "order_items" oi
SET "gstRatePercent" = CASE
  WHEN t."taxRule" = 'VALUE_SLAB' THEN
    CASE WHEN oi."pricePaise"::bigint * 100 <= gst.threshold * (100 + gst.merit) THEN gst.merit ELSE gst.standard END
  ELSE COALESCE(t."defaultTaxRatePercent", gst.standard)
END
FROM "products" p
LEFT JOIN tax t ON t.leaf = p."categoryId",
  gst
WHERE p.id = oi."productId";
