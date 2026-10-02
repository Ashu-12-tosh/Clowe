-- GST 2.0: one rate function, category-derived, and the rates corrected.
--
-- HAND-WRITTEN. `prisma migrate diff` against this schema also emits
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "searchVector" DROP DEFAULT;
-- because it cannot express the hand-managed full-text search objects (see
-- 20260914120000_product_search_fts). Those two lines are deliberately left
-- out: running them would silently switch off product search.
--
-- Not additive, deliberately:
--   * products.taxRatePercent is dropped. It held a GST rate the seller picked
--     from 0/5/12/18/28; 12% and 28% are no longer lawful goods rates and the
--     rate is now derived from the category. Local count before: 2 products
--     (one at 5%, one at 28%).
--   * the flat gstRatePercent setting is removed; its stored row, if any, goes.
--   * APPAREL_SLAB (5% up to Rs 1,000, else 12%, on the inclusive price) becomes
--     VALUE_SLAB (5% up to Rs 2,500 per piece ex-GST, else 18%).
--   * every department's rate is set to the GST 2.0 table below — the same table
--     prisma/seed/categoryRules.ts seeds, generated from one list. On a fresh
--     database these UPDATEs match nothing and the seed applies the table.

ALTER TABLE "products" DROP COLUMN "taxRatePercent";

DELETE FROM "platform_settings" WHERE "key" = 'gstRatePercent';

UPDATE "categories" SET "taxRule" = 'VALUE_SLAB' WHERE "taxRule" = 'APPAREL_SLAB';

UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8471' WHERE "slug" = 'electronics'; -- Sch II 456 et seq.
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8517' WHERE "slug" = 'mobiles'; -- Sch II 490
UPDATE "categories" SET "taxRule" = 'VALUE_SLAB', "defaultTaxRatePercent" = NULL, "hsnCode" = '6109' WHERE "slug" = 'fashion'; -- Ch 61/62: Sch I 388-389 / Sch II 197-198
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = NULL WHERE "slug" = 'home-kitchen'; -- mixed; standard rate
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '3304' WHERE "slug" = 'beauty'; -- Sch II 61 (make-up, skincare)
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 0, "hsnCode" = '4901' WHERE "slug" = 'books'; -- nil: 10/2025 entry 132
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 5, "hsnCode" = '2106' WHERE "slug" = 'supplements'; -- Sch I 145 (was 18)
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 5, "hsnCode" = '9506' WHERE "slug" = 'sports'; -- Sch I 499 (was 12)
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '9504' WHERE "slug" = 'gaming'; -- Sch II 617
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 5, "hsnCode" = NULL WHERE "slug" = 'grocery'; -- Sch I (packaged food)
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 5, "hsnCode" = '9503' WHERE "slug" = 'toys-kids'; -- Sch I 497 (was 12)

UPDATE "categories" SET "taxRule" = 'VALUE_SLAB', "defaultTaxRatePercent" = NULL, "hsnCode" = '6403' WHERE "slug" = 'fashion-footwear'; -- per pair: Sch I 392 / Sch II 202-206
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '4202' WHERE "slug" = 'fashion-bags'; -- Sch II 145 (cotton/jute handbags 5%: mixed)
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '9102' WHERE "slug" = 'fashion-watches'; -- Sch II 583-584
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '9004' WHERE "slug" = 'fashion-sunglasses'; -- Sch II 558
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 3, "hsnCode" = '7117' WHERE "slug" = 'fashion-jewellery'; -- Sch IV 10, 14
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 5, "hsnCode" = '6505' WHERE "slug" = 'fashion-caps'; -- textile caps: Sch I 393-394
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '4203' WHERE "slug" = 'fashion-accessories'; -- belts Sch II 146 (umbrellas, combs 5%: mixed)
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8471' WHERE "slug" = 'electronics-accessories'; -- 
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8516' WHERE "slug" = 'electronics-appliances'; -- mixed appliances, all 18%
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8525' WHERE "slug" = 'electronics-cameras'; -- Sch II 497
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 5, "hsnCode" = '8806' WHERE "slug" = 'electronics-drones'; -- Sch I 464
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '9504' WHERE "slug" = 'electronics-gaming'; -- Sch II 617
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8518' WHERE "slug" = 'electronics-headphones'; -- Sch II 491
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8471' WHERE "slug" = 'electronics-laptops'; -- Sch II 456
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8517' WHERE "slug" = 'electronics-smartphones'; -- Sch II 490
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8517' WHERE "slug" = 'electronics-smartwatches'; -- Sch II 490
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8518' WHERE "slug" = 'electronics-speakers'; -- Sch II 491
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8471' WHERE "slug" = 'electronics-tablets'; -- Sch II 456
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '8528' WHERE "slug" = 'electronics-tvs'; -- Sch II 500, all sizes (was 28)
UPDATE "categories" SET "taxRule" = 'VALUE_SLAB', "defaultTaxRatePercent" = NULL, "hsnCode" = '6302' WHERE "slug" = 'home-bedding'; -- made-up textiles per piece: Sch I 390 / Sch II 199
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 5, "hsnCode" = '7323' WHERE "slug" = 'home-cookware'; -- metal/ceramic utensils Sch I 416-419 (plastic 18%: mixed)
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = NULL WHERE "slug" = 'home-decor'; -- mixed (carpets, candles 5%); standard rate
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '9403' WHERE "slug" = 'home-furniture'; -- Sch II 612
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = NULL WHERE "slug" = 'home-appliances'; -- 
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 5, "hsnCode" = '3305' WHERE "slug" = 'beauty-haircare'; -- shampoo, hair oil Sch I 245-246 (other hair products 18%: mixed)
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '3303' WHERE "slug" = 'beauty-fragrances'; -- Sch II 64
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 18, "hsnCode" = '9506' WHERE "slug" = 'sports-fitness'; -- gym equipment Sch II 619
UPDATE "categories" SET "taxRule" = 'VALUE_SLAB', "defaultTaxRatePercent" = NULL, "hsnCode" = '6211' WHERE "slug" = 'sports-sportswear'; -- apparel
UPDATE "categories" SET "taxRule" = NULL, "defaultTaxRatePercent" = 0, "hsnCode" = '4820' WHERE "slug" = 'toys-school'; -- notebooks, pencils nil (pens, diaries, bags 18%: mixed)
