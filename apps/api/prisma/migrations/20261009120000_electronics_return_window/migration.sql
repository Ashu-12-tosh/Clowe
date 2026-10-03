-- Electronics stops setting its own return window (10 days) and follows the
-- platform setting. Grocery keeps its 2 days. Order lines already sold keep
-- the window they were sold with (order_items."returnWindowDays").
UPDATE "categories" SET "returnWindowDays" = NULL WHERE slug = 'electronics';
