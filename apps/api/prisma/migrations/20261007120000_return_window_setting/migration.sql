-- The return window becomes one platform setting, 5 days, and every order
-- line keeps the window it was sold with.

-- 1. Each order line carries its own window from now on.
ALTER TABLE "order_items" ADD COLUMN "returnWindowDays" INTEGER;

-- 2. Lines sold before this migration keep the window they were sold with,
--    by the rule in force until now: the seller's own window, else the
--    nearest category up the tree that sets one, else the platform setting,
--    else 7 days (the platform default until now). Runs before step 3 so it
--    reads the old values.
WITH RECURSIVE chain AS (
  SELECT id AS leaf, "parentId", "returnWindowDays", 0 AS depth
  FROM "categories"
  UNION ALL
  SELECT chain.leaf, c."parentId", c."returnWindowDays", chain.depth + 1
  FROM chain
  JOIN "categories" c ON c.id = chain."parentId"
  WHERE chain."returnWindowDays" IS NULL
),
category_window AS (
  SELECT DISTINCT ON (leaf) leaf, "returnWindowDays"
  FROM chain
  WHERE "returnWindowDays" IS NOT NULL
  ORDER BY leaf, depth
)
UPDATE "order_items" oi
SET "returnWindowDays" = COALESCE(
  sp."returnWindowDays",
  cw."returnWindowDays",
  (SELECT (ps.value #>> '{}')::int FROM "platform_settings" ps WHERE ps.key = 'returnWindowDays'),
  7
)
FROM "products" p
LEFT JOIN category_window cw ON cw.leaf = p."categoryId",
  "seller_profiles" sp
WHERE p.id = oi."productId"
  AND sp.id = oi."sellerId";

-- 3. 7 days becomes 5. A saved platform setting of 7 moves to 5 (any other
--    value was an admin's deliberate choice and stays); with no row the
--    code default, now 5, applies. Categories that set 7 were copies of the
--    old platform default, so they go back to following the setting.
--    Categories with their own window (electronics 10, grocery 2) keep it.
UPDATE "platform_settings"
SET value = '5'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE key = 'returnWindowDays' AND value = '7'::jsonb;

UPDATE "categories" SET "returnWindowDays" = NULL WHERE "returnWindowDays" = 7;

-- 4. Copy that spelled out the old window. The seeded demo descriptions and
--    the fashion landing strip were written by the platform, not by sellers;
--    nothing a seller wrote is touched.
UPDATE "categories"
SET features = replace(features::text, '"7 days return policy"', '"Hassle-free return policy"')::jsonb
WHERE features::text LIKE '%"7 days return policy"%';

UPDATE "products"
SET description = replace(
  replace(description, 'Clowe''s 7-day easy returns', 'Clowe''s easy returns'),
  'Easy 7-day returns',
  'Easy returns'
)
WHERE description LIKE '%Seeded demo product%'
  AND description LIKE '%7-day%';
