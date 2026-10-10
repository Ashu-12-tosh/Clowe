-- Seeded marketing copy that claimed what the site cannot back up ("1000+
-- premium brands", "100% original products", "Best prices", "thousands of
-- products"). Each change replaces the exact seeded text, so anything an admin
-- has since rewritten is left as it is. The seeds now write the same new text.

-- Fashion: landing highlights and feature strip.
UPDATE "categories"
SET "highlights" = replace("highlights"::text,
      '{"icon": "⭐", "title": "Top Brands", "subtitle": "1000+ Premium Brands"}',
      '{"icon": "✅", "title": "Approved Sellers", "subtitle": "Every Shop Reviewed"}')::jsonb
WHERE "slug" = 'fashion' AND "highlights"::text LIKE '%1000+ Premium Brands%';

UPDATE "categories"
SET "features" = replace(replace(replace("features"::text,
      '{"icon": "✨", "title": "Latest Trends", "subtitle": "New styles added daily"}',
      '{"icon": "✨", "title": "Latest Trends", "subtitle": "New styles from our sellers"}'),
      '{"icon": "⭐", "title": "Top Brands", "subtitle": "1000+ premium brands"}',
      '{"icon": "✅", "title": "Approved Sellers", "subtitle": "Every shop is reviewed before it sells"}'),
      '{"icon": "💎", "title": "Premium Quality", "subtitle": "100% original products"}',
      '{"icon": "💎", "title": "Listings Reviewed", "subtitle": "Checked before they go live"}')::jsonb
WHERE "slug" = 'fashion' AND "features" IS NOT NULL;

-- Electronics: landing highlights and feature strip.
UPDATE "categories"
SET "highlights" = replace(replace("highlights"::text,
      '{"icon": "⭐", "title": "Top Brands", "subtitle": "Best of tech, all in one place"}',
      '{"icon": "⭐", "title": "Known Brands", "subtitle": "Tech from approved sellers"}'),
      '{"icon": "🛡", "title": "Secure Payments", "subtitle": "100% safe & secure"}',
      '{"icon": "🛡", "title": "Secure Payments", "subtitle": "Safe & secure checkout"}')::jsonb
WHERE "slug" = 'electronics' AND "highlights" IS NOT NULL;

UPDATE "categories"
SET "features" = replace(replace(replace("features"::text,
      '{"icon": "⭐", "title": "Top Brands", "subtitle": "Best of tech, all in one place."}',
      '{"icon": "⭐", "title": "Known Brands", "subtitle": "Tech from approved sellers."}'),
      '{"icon": "🏷", "title": "Unbeatable Deals", "subtitle": "Best prices on top products."}',
      '{"icon": "🏷", "title": "Clear Pricing", "subtitle": "GST included in every price."}'),
      '{"icon": "🛡", "title": "Secure Payments", "subtitle": "100% safe & secure."}',
      '{"icon": "🛡", "title": "Secure Payments", "subtitle": "Safe & secure checkout."}')::jsonb
WHERE "slug" = 'electronics' AND "features" IS NOT NULL;

-- Home hero banner.
UPDATE "home_banners"
SET "subtext" = 'Discover products from approved sellers, with intelligent recommendations and personalised shopping.'
WHERE "subtext" = 'Discover thousands of products with intelligent recommendations and personalised shopping.';

-- Promo strip (hidden while the food categories are closed).
UPDATE "promo_tiles" SET "title" = 'Supplements' WHERE "title" = 'Genuine Supplements';
