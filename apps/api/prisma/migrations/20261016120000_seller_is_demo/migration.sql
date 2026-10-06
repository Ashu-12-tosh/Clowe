-- The seeded demo store, hidden from shoppers with every product it carries
-- while the demoCatalogEnabled platform setting is off. Nothing is deleted.
ALTER TABLE "seller_profiles" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Every seed creates its demo products under one seller: phone 9000000001,
-- "Clowe Demo Store" (prisma/seed.ts, seed/electronics.ts, seed/fashion.ts,
-- seed/marketplace.ts). Only that seller is marked.
UPDATE "seller_profiles" SET "isDemo" = true
WHERE "userId" IN (SELECT "id" FROM "users" WHERE "phone" = '9000000001');
