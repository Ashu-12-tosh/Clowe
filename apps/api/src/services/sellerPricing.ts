import type { Prisma } from '@prisma/client';
import {
  buyerPriceFor,
  gstRateForInclusive,
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

/**
 * The GST rate each line of a new order is sold at, from the unit price the
 * buyer is charged (after any promotion) under today's rules. Checkout stores
 * it on the line so a later GST change never rewrites the sale.
 */
export async function saleGstRates(lines: { productId: string; unitPaise: number }[]): Promise<number[]> {
  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.productId))] } },
    select: { id: true, categoryId: true },
  });
  const categoryOf = new Map(products.map((p) => [p.id, p.categoryId]));
  const [rules, settings] = await Promise.all([categoryRulesMap([...new Set(categoryOf.values())]), getSettings()]);
  const gst = gstSettings(settings);
  return lines.map((l) => gstRateForInclusive(l.unitPaise, rules.get(categoryOf.get(l.productId) ?? ''), gst).ratePercent);
}

/**
 * Give every order line that recorded no GST rate (written outside checkout)
 * the rate today's rules give it. Run before the rules change, so no past
 * sale is ever re-taxed at the new rate.
 */
export async function recordOrderLineGstRates(): Promise<number> {
  const lines = await prisma.orderItem.findMany({
    where: { gstRatePercent: null },
    select: { id: true, pricePaise: true, product: { select: { categoryId: true } } },
  });
  if (lines.length === 0) return 0;
  const [rules, settings] = await Promise.all([
    categoryRulesMap([...new Set(lines.map((l) => l.product.categoryId))]),
    getSettings(),
  ]);
  const gst = gstSettings(settings);
  for (const l of lines) {
    const rate = gstRateForInclusive(l.pricePaise, rules.get(l.product.categoryId), gst).ratePercent;
    await prisma.orderItem.update({ where: { id: l.id }, data: { gstRatePercent: rate } });
  }
  return lines.length;
}

/**
 * Change GST rules safely: record the rate on any order line missing one and
 * give every variant without one its seller price, both under the rules in
 * force; then write the change (`write`); then reprice buyer prices from the
 * sellers' under the new rules. `where` narrows the reprice (a category).
 */
export async function changeGstRules(
  write: () => Promise<void>,
  where: Prisma.ProductWhereInput = {},
): Promise<PriceChange[]> {
  await recordOrderLineGstRates();
  await ensureSellerPrices(where, true);
  await write();
  return repriceProducts(where);
}

/** One variant's prices before and after a backfill or reprice, for the report. */
export interface PriceChange {
  productId: string;
  title: string;
  categoryId: string;
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
        categoryId: p.categoryId,
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
export async function repriceProducts(
  where: Prisma.ProductWhereInput,
  opts: {
    /** Price under these GST settings instead of today's: a dry run of a change. */
    priceGst?: GstSettings;
    /** False: report only, write nothing. */
    apply?: boolean;
  } = {},
): Promise<PriceChange[]> {
  const { products, rules } = await variantsWithRules(where);
  // A variant without a seller price is read under today's rules — the ones
  // its buyer price was set under — whatever it is about to be priced at.
  const current = gstSettings(await getSettings());
  const gst = opts.priceGst ?? current;
  const apply = opts.apply ?? true;
  const changes: PriceChange[] = [];
  for (const p of products) {
    const r = rules.get(p.categoryId);
    let minBuyer: number | null = null;
    let moved = false;
    for (const v of p.variants) {
      const { sellerPricePaise, sellerMrpPaise } = sellerPricesOf(v, r, current);
      // Where the rate does not change, the buyer price stays to the paisa
      // (buyerFor), rather than moving by a rounding step.
      const price = { ...buyerPriceFor(sellerPricePaise, r, gst), buyerPaise: buyerFor(sellerPricePaise, v.pricePaise, r, gst) };
      const mrp = sellerMrpPaise === null ? null : buyerFor(sellerMrpPaise, v.mrpPaise, r, gst);
      minBuyer = minBuyer === null ? price.buyerPaise : Math.min(minBuyer, price.buyerPaise);
      if (price.buyerPaise === v.pricePaise && mrp === v.mrpPaise) continue;
      moved = true;
      changes.push({
        productId: p.id,
        title: p.title,
        categoryId: p.categoryId,
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
      if (!apply) continue;
      await prisma.productVariant.update({
        where: { id: v.id },
        data: { pricePaise: price.buyerPaise, mrpPaise: mrp, sellerPricePaise, sellerMrpPaise },
      });
    }
    if (apply && moved && minBuyer !== null) {
      await prisma.product.update({ where: { id: p.id }, data: { basePricePaise: minBuyer } });
    }
  }
  return changes;
}
