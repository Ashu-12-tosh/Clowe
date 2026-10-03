import type { Prisma } from '@prisma/client';
import {
  buyerPriceFor,
  sellerPriceFromBuyer,
  type CategoryRules,
  type GstSettings,
  type SellerProductUpsertInput,
  type SellerVariantInput,
} from '@clowe/shared';
import { prisma } from '../db';
import { categoryRulesMap } from './categoryRules';
import { gstSettings } from './economicsRates';
import { getSettings } from './settingsService';

// ---------------------------------------------------------------------------
// Seller prices are entered BEFORE GST.
//
// A variant stores both numbers: the seller's (sellerPricePaise, ex-GST) and
// the buyer's (pricePaise, GST included), which is what every shopper-facing
// read, the cart and checkout use. The buyer's is always written from the
// seller's here, so the two cannot drift; when the GST rules change,
// repriceProducts moves the buyer prices and the seller's stay put.
// ---------------------------------------------------------------------------

type TaxRules = Pick<CategoryRules, 'taxRule' | 'defaultTaxRatePercent'> | null | undefined;

/** A variant as stored, for working out its seller price. */
interface StoredPrices {
  pricePaise: number;
  mrpPaise: number | null;
  sellerPricePaise: number | null;
  sellerMrpPaise: number | null;
}

/** The seller's price and MRP for a stored variant: as entered, or derived from the buyer price. */
export function sellerPricesOf(v: StoredPrices, rules: TaxRules, gst: GstSettings) {
  return {
    sellerPricePaise: v.sellerPricePaise ?? sellerPriceFromBuyer(v.pricePaise, rules, gst).exGstPaise,
    sellerMrpPaise:
      v.mrpPaise === null ? null : (v.sellerMrpPaise ?? sellerPriceFromBuyer(v.mrpPaise, rules, gst).exGstPaise),
  };
}

/**
 * The buyer price for a seller price. When the variant already has a buyer
 * price that this seller price is what it implies, that buyer price is kept
 * to the paisa: a listing priced before sellers entered ex-GST, saved without
 * a price change, must not move by a rounding step.
 */
function buyerFor(sellerPaise: number, current: number | null | undefined, rules: TaxRules, gst: GstSettings): number {
  if (current != null && sellerPriceFromBuyer(current, rules, gst).exGstPaise === sellerPaise) {
    const rebuilt = buyerPriceFor(sellerPaise, rules, gst).buyerPaise;
    // Same rate either way, so only a rounding step can separate them.
    if (Math.abs(rebuilt - current) <= 1) return current;
  }
  return buyerPriceFor(sellerPaise, rules, gst).buyerPaise;
}

export type PricedVariantInput = SellerVariantInput & { pricePaise: number; mrpPaise: number | null };
export type PricedUpsertInput = Omit<SellerProductUpsertInput, 'variants'> & { variants: PricedVariantInput[] };

/**
 * The submitted variants with their buyer prices added, priced on `categoryId`
 * (the live category for a live listing, whose category change waits for
 * review). `current` carries the stored variants, by id.
 */
export async function priceInput(
  input: SellerProductUpsertInput,
  categoryId: string,
  current: Map<string, StoredPrices> = new Map(),
): Promise<PricedUpsertInput> {
  const [rulesById, settings] = await Promise.all([categoryRulesMap([categoryId]), getSettings()]);
  const rules = rulesById.get(categoryId);
  const gst = gstSettings(settings);
  return {
    ...input,
    variants: input.variants.map((v) => {
      const stored = v.id ? current.get(v.id) : undefined;
      return {
        ...v,
        pricePaise: buyerFor(v.sellerPricePaise, stored?.pricePaise, rules, gst),
        mrpPaise: v.sellerMrpPaise == null ? null : buyerFor(v.sellerMrpPaise, stored?.mrpPaise, rules, gst),
      };
    }),
  };
}

/** One variant's prices before and after a backfill or reprice, for the report. */
export interface PriceChange {
  productId: string;
  title: string;
  variantId: string;
  label: string;
  buyerBefore: number;
  buyerAfter: number;
  sellerPrice: number;
  mrpBuyerBefore: number | null;
  mrpBuyerAfter: number | null;
  sellerMrp: number | null;
  ratePercent: number;
  /** In the value-slab band: the seller price found would be taxed at the merit rate if re-saved. */
  ambiguous: boolean;
}

async function variantsWithRules(where: Prisma.ProductWhereInput) {
  const products = await prisma.product.findMany({
    where,
    select: {
      id: true,
      title: true,
      categoryId: true,
      variants: {
        select: { id: true, label: true, pricePaise: true, mrpPaise: true, sellerPricePaise: true, sellerMrpPaise: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const rules = await categoryRulesMap([...new Set(products.map((p) => p.categoryId))]);
  return { products, rules };
}

/**
 * Give every variant without one its seller price, derived from its buyer
 * price under today's GST rules. Buyer prices are not touched. Returns what
 * it would write (dry run) or wrote.
 */
export async function ensureSellerPrices(where: Prisma.ProductWhereInput, apply: boolean): Promise<PriceChange[]> {
  const { products, rules } = await variantsWithRules(where);
  const gst = gstSettings(await getSettings());
  const changes: PriceChange[] = [];
  for (const p of products) {
    const r = rules.get(p.categoryId);
    for (const v of p.variants) {
      if (v.sellerPricePaise !== null && (v.mrpPaise === null || v.sellerMrpPaise !== null)) continue;
      const derived = sellerPriceFromBuyer(v.pricePaise, r, gst);
      const { sellerPricePaise, sellerMrpPaise } = sellerPricesOf(v, r, gst);
      changes.push({
        productId: p.id,
        title: p.title,
        variantId: v.id,
        label: v.label,
        buyerBefore: v.pricePaise,
        buyerAfter: v.pricePaise,
        sellerPrice: sellerPricePaise,
        mrpBuyerBefore: v.mrpPaise,
        mrpBuyerAfter: v.mrpPaise,
        sellerMrp: sellerMrpPaise,
        ratePercent: derived.ratePercent,
        ambiguous: derived.ambiguous,
      });
      if (apply) {
        await prisma.productVariant.update({ where: { id: v.id }, data: { sellerPricePaise, sellerMrpPaise } });
      }
    }
  }
  return changes;
}

/**
 * Rewrite buyer prices from seller prices under today's GST rules — after an
 * admin changes a GST rate or a category's rule. Seller prices stay as they
 * are; call ensureSellerPrices first, under the old rules, so a variant that
 * had none keeps the seller price it was sold at. Returns the variants whose
 * buyer price moved.
 */
export async function repriceProducts(where: Prisma.ProductWhereInput): Promise<PriceChange[]> {
  const { products, rules } = await variantsWithRules(where);
  const gst = gstSettings(await getSettings());
  const changes: PriceChange[] = [];
  for (const p of products) {
    const r = rules.get(p.categoryId);
    let minBuyer: number | null = null;
    let moved = false;
    for (const v of p.variants) {
      const { sellerPricePaise, sellerMrpPaise } = sellerPricesOf(v, r, gst);
      const price = buyerPriceFor(sellerPricePaise, r, gst);
      const mrp = sellerMrpPaise === null ? null : buyerPriceFor(sellerMrpPaise, r, gst).buyerPaise;
      minBuyer = minBuyer === null ? price.buyerPaise : Math.min(minBuyer, price.buyerPaise);
      if (price.buyerPaise === v.pricePaise && mrp === v.mrpPaise) continue;
      moved = true;
      changes.push({
        productId: p.id,
        title: p.title,
        variantId: v.id,
        label: v.label,
        buyerBefore: v.pricePaise,
        buyerAfter: price.buyerPaise,
        sellerPrice: sellerPricePaise,
        mrpBuyerBefore: v.mrpPaise,
        mrpBuyerAfter: mrp,
        sellerMrp: sellerMrpPaise,
        ratePercent: price.ratePercent,
        ambiguous: false,
      });
      await prisma.productVariant.update({
        where: { id: v.id },
        data: { pricePaise: price.buyerPaise, mrpPaise: mrp, sellerPricePaise, sellerMrpPaise },
      });
    }
    if (moved && minBuyer !== null) {
      await prisma.product.update({ where: { id: p.id }, data: { basePricePaise: minBuyer } });
    }
  }
  return changes;
}
