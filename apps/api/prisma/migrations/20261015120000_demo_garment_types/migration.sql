-- Two demo listings in Winter Wear carried the wrong Type spec value: the seed's
-- rules read "Sweatshirt" as a T-shirt and "Denim ... Jacket" as jeans. The
-- listings are filed correctly; only the value was wrong. Each row is
-- rewritten only if it still holds the wrong value, so a seller's or admin's
-- own edit is left alone, and a catalog without these demo listings is untouched.
UPDATE "products" p
SET attributes = (
  SELECT jsonb_agg(
    CASE WHEN a->>'key' = 'garment_type' AND a->>'value' = 'T-shirt' THEN jsonb_set(a, '{value}', '"Sweatshirt"') ELSE a END
    ORDER BY ord
  )
  FROM jsonb_array_elements(p.attributes) WITH ORDINALITY AS t(a, ord)
)
WHERE p.slug = 'zephyr-hooded-sweatshirt'
  AND jsonb_typeof(p.attributes) = 'array'
  AND p.attributes @> '[{"key": "garment_type", "value": "T-shirt"}]';

UPDATE "products" p
SET attributes = (
  SELECT jsonb_agg(
    CASE WHEN a->>'key' = 'garment_type' AND a->>'value' = 'Jeans' THEN jsonb_set(a, '{value}', '"Jacket"') ELSE a END
    ORDER BY ord
  )
  FROM jsonb_array_elements(p.attributes) WITH ORDINALITY AS t(a, ord)
)
WHERE p.slug = 'denimco-denim-trucker-jacket'
  AND jsonb_typeof(p.attributes) = 'array'
  AND p.attributes @> '[{"key": "garment_type", "value": "Jeans"}]';
