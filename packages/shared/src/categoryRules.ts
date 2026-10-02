import { z } from 'zod';
import { variantAxisSchema, type VariantAxis } from './variants';

// ---------------------------------------------------------------------------
// Category rules
//
// The category tree carries the marketplace's per-department behaviour instead
// of code checking for `'fashion'`: which option axes variants use, which spec
// fields a listing needs, whether AI Try-On / the size guide apply, the GST
// default and the return window. Every field is nullable on a category and is
// inherited from the parent when unset, so admins only fill in what differs.
// ---------------------------------------------------------------------------

export const ATTRIBUTE_TYPES = ['text', 'number', 'select'] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** One field of a category's spec sheet. */
export interface AttributeDef {
  /** Machine key, e.g. "ram", "author", "net_quantity". */
  key: string;
  /** Label shown to sellers and shoppers, e.g. "Net quantity". */
  label: string;
  type: AttributeType;
  /** Unit hint for numbers, e.g. "g", "W", "inches". */
  unit?: string;
  /** Sellers must fill this in before submitting for review. */
  required?: boolean;
  /** Choices for `select` fields. */
  options?: string[];
  placeholder?: string;
}

export const attributeDefSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string().trim().min(1).max(40),
  type: z.enum(ATTRIBUTE_TYPES).default('text'),
  unit: z.string().trim().max(12).optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
  placeholder: z.string().trim().max(60).optional(),
});

/**
 * 'VALUE_SLAB' = the GST 2.0 value-based slab for apparel and made-up textiles
 * (per piece) and footwear (per pair): the merit rate when the sale value of
 * one unit, ex-GST and after discount, is at or below the threshold, else the
 * standard rate. Notification 9/2025-Central Tax (Rate), in force 22.09.2025:
 * Sch I 388–390, 392 at 5%; Sch II 197–199, 202–206 at 18%. The threshold and
 * both rates are platform settings (GstSettings), not constants.
 */
export const TAX_RULES = ['VALUE_SLAB'] as const;
export type TaxRule = (typeof TAX_RULES)[number];

/**
 * The goods rates GST 2.0 leaves (9/2025-CT(R) schedules: nil, 3% for
 * jewellery, 5% merit, 18% standard, 40% demerit). The 12% and 28% slabs are
 * gone — 28% last held only tobacco, moved to 40% by 19/2025-CT(R) from
 * 1.2.2026 — so a category default can only be one of these.
 */
export const GST_RATES_PERCENT = [0, 3, 5, 18, 40] as const;

/** The admin's GST settings the rate function needs. */
export interface GstSettings {
  /** The lower slab, 5% under GST 2.0. */
  meritPercent: number;
  /** The standard rate, 18%; also the fallback for a category with no rate. */
  standardPercent: number;
  /** Value-slab threshold per piece or pair, ex-GST: ₹2,500 under GST 2.0. */
  valueSlabThresholdPaise: number;
}

/** The rate for one unit, and how it was decided. */
export interface GstRate {
  ratePercent: number;
  /** The unit's value net of GST at that rate. */
  exGstUnitPaise: number;
  /**
   * Set when a GST-inclusive unit price sits in the band where neither slab is
   * self-consistent (see gstRateFor) — the seller should know a price at or
   * below `meritUpToPaise` would be taxed at the merit rate.
   */
  slabBand: { fromPaise: number; toPaise: number; meritUpToPaise: number } | null;
}

/** Rule fields as stored on one category; null / empty = inherit from the parent. */
export interface CategoryRuleFields {
  variantAxes: VariantAxis[] | null;
  attributeSchema: AttributeDef[] | null;
  tryOnEligible: boolean | null;
  sizeGuide: boolean | null;
  taxRule: TaxRule | null;
  defaultTaxRatePercent: number | null;
  hsnCode: string | null;
  returnWindowDays: number | null;
}

/** Fully resolved rules for a category (own → parent → root → platform default). */
export interface CategoryRules {
  /** Option axes to offer sellers in this category (they may still add their own). */
  variantAxes: VariantAxis[];
  attributeSchema: AttributeDef[];
  tryOnEligible: boolean;
  sizeGuide: boolean;
  taxRule: TaxRule | null;
  defaultTaxRatePercent: number | null;
  hsnCode: string | null;
  /** null = platform-wide default from settings. */
  returnWindowDays: number | null;
}

/** Admin input for the rule fields (all optional; null clears = inherit). */
export const categoryRulesInputSchema = z.object({
  variantAxes: z.array(variantAxisSchema).max(3).nullable().optional(),
  attributeSchema: z.array(attributeDefSchema).max(30).nullable().optional(),
  tryOnEligible: z.boolean().nullable().optional(),
  sizeGuide: z.boolean().nullable().optional(),
  taxRule: z.enum(TAX_RULES).nullable().optional(),
  defaultTaxRatePercent: z
    .number()
    .int()
    .refine((r) => (GST_RATES_PERCENT as readonly number[]).includes(r), {
      message: `GST under GST 2.0 is one of ${GST_RATES_PERCENT.join(', ')}%`,
    })
    .nullable()
    .optional(),
  hsnCode: z.string().trim().max(12).nullable().optional(),
  returnWindowDays: z.number().int().min(0).max(90).nullable().optional(),
});
export type CategoryRulesInput = z.infer<typeof categoryRulesInputSchema>;

const EMPTY_RULES: CategoryRules = {
  variantAxes: [],
  attributeSchema: [],
  tryOnEligible: false,
  sizeGuide: false,
  taxRule: null,
  defaultTaxRatePercent: null,
  hsnCode: null,
  returnWindowDays: null,
};

function isSet<T>(value: T | null | undefined): value is T {
  if (value === null || value === undefined) return false;
  return !(Array.isArray(value) && value.length === 0);
}

/**
 * Resolve rules along a chain ordered nearest-first: [category, parent, root].
 * Tax is resolved as a unit (rule + rate from the same category) so a child
 * that sets a flat rate is not overridden by the root's apparel slab.
 */
export function resolveCategoryRules(chain: CategoryRuleFields[]): CategoryRules {
  const first = <K extends keyof CategoryRuleFields>(key: K): NonNullable<CategoryRuleFields[K]> | null => {
    for (const node of chain) {
      const value = node[key];
      if (isSet(value)) return value as NonNullable<CategoryRuleFields[K]>;
    }
    return null;
  };
  const taxNode = chain.find((c) => isSet(c.taxRule) || isSet(c.defaultTaxRatePercent));
  return {
    variantAxes: first('variantAxes') ?? EMPTY_RULES.variantAxes,
    attributeSchema: first('attributeSchema') ?? EMPTY_RULES.attributeSchema,
    tryOnEligible: first('tryOnEligible') ?? EMPTY_RULES.tryOnEligible,
    sizeGuide: first('sizeGuide') ?? EMPTY_RULES.sizeGuide,
    taxRule: taxNode?.taxRule ?? null,
    defaultTaxRatePercent: taxNode?.defaultTaxRatePercent ?? null,
    hsnCode: first('hsnCode'),
    returnWindowDays: first('returnWindowDays'),
  };
}

/** Parse the JSON rule columns of a raw category row into typed fields. */
export function categoryRuleFieldsFromRow(row: {
  variantAxes: unknown;
  attributeSchema: unknown;
  tryOnEligible: boolean | null;
  sizeGuide: boolean | null;
  taxRule: string | null;
  defaultTaxRatePercent: number | null;
  hsnCode: string | null;
  returnWindowDays: number | null;
}): CategoryRuleFields {
  const axes = z.array(variantAxisSchema).safeParse(row.variantAxes);
  const attrs = z.array(attributeDefSchema).safeParse(row.attributeSchema);
  return {
    variantAxes: axes.success ? axes.data : null,
    attributeSchema: attrs.success ? attrs.data : null,
    tryOnEligible: row.tryOnEligible,
    sizeGuide: row.sizeGuide,
    taxRule: (TAX_RULES as readonly string[]).includes(row.taxRule ?? '')
      ? (row.taxRule as TaxRule)
      : null,
    defaultTaxRatePercent: row.defaultTaxRatePercent,
    hsnCode: row.hsnCode,
    returnWindowDays: row.returnWindowDays,
  };
}

/**
 * THE GST rate for one unit. Every place that needs a rate — the seller's
 * pricing breakdown, the ledger, the tax invoice, the admin order view — asks
 * this, with the category's rules and the admin's GST settings; nothing picks
 * a rate of its own, and sellers do not choose one.
 *
 * `unitPricePaise` is what the buyer pays for one piece or pair, GST included
 * and after any discount on it (s.15(3)(a) CGST Act: an invoiced discount
 * reduces the value). Clowe prices are GST-inclusive.
 *
 * The value slab is judged on the unit's value EX-GST (s.15: transaction value
 * excludes GST), which makes an inclusive price circular: between threshold ×
 * (1 + merit) and threshold × (1 + standard) — ₹2,625 to ₹2,950 at 5/18% on
 * ₹2,500 — neither rate is self-consistent, and no CBIC guidance covers it.
 * The rule here tests the value at the merit rate: at or under the threshold
 * it is the merit rate, otherwise the standard rate. That never under-collects
 * tax; the price band is reported so the seller can be told.
 */
export function gstRateFor(
  unitPricePaise: number,
  rules: Pick<CategoryRules, 'taxRule' | 'defaultTaxRatePercent'> | null | undefined,
  gst: GstSettings,
): GstRate {
  const price = Math.max(0, Math.round(unitPricePaise));
  const exAt = (rate: number) => Math.round((price * 100) / (100 + rate));

  if (rules?.taxRule === 'VALUE_SLAB') {
    const threshold = gst.valueSlabThresholdPaise;
    // Integer comparison: price/(1+m) <= threshold  ⇔  price*100 <= threshold*(100+m).
    if (price * 100 <= threshold * (100 + gst.meritPercent)) {
      return { ratePercent: gst.meritPercent, exGstUnitPaise: exAt(gst.meritPercent), slabBand: null };
    }
    const meritUpTo = Math.floor((threshold * (100 + gst.meritPercent)) / 100);
    const bandTop = Math.floor((threshold * (100 + gst.standardPercent)) / 100);
    return {
      ratePercent: gst.standardPercent,
      exGstUnitPaise: exAt(gst.standardPercent),
      slabBand: price <= bandTop ? { fromPaise: meritUpTo + 1, toPaise: bandTop, meritUpToPaise: meritUpTo } : null,
    };
  }
  const rate = rules?.defaultTaxRatePercent ?? gst.standardPercent;
  return { ratePercent: rate, exGstUnitPaise: exAt(rate), slabBand: null };
}

/** How a category's GST reads in a form, e.g. "5% up to ₹2,500, 18% above" or "18%". */
export function describeTaxDefault(
  rules: Pick<CategoryRules, 'taxRule' | 'defaultTaxRatePercent'>,
  gst: GstSettings,
): string {
  if (rules.taxRule === 'VALUE_SLAB') {
    const rupees = (gst.valueSlabThresholdPaise / 100).toLocaleString('en-IN');
    return `${gst.meritPercent}% up to ₹${rupees} per piece (ex-GST), ${gst.standardPercent}% above`;
  }
  return `${rules.defaultTaxRatePercent ?? gst.standardPercent}%`;
}
