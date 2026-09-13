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

/** 'APPAREL_SLAB' = textile GST: 5% up to ₹1,000 per piece, 12% above. */
export const TAX_RULES = ['APPAREL_SLAB'] as const;
export type TaxRule = (typeof TAX_RULES)[number];

/** Standard GST slab used when neither the listing nor its category says otherwise. */
export const DEFAULT_GST_PERCENT = 18;

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
  defaultTaxRatePercent: z.number().int().min(0).max(28).nullable().optional(),
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
 * GST rate for a line: the listing's own slab if set, else the category rule.
 * Prices on Clowe are tax-inclusive, so callers back the tax out of the price.
 */
export function gstRateFor(
  unitPricePaise: number,
  listingRate: number | null | undefined,
  rules: Pick<CategoryRules, 'taxRule' | 'defaultTaxRatePercent'>,
): number {
  if (listingRate != null) return listingRate;
  if (rules.taxRule === 'APPAREL_SLAB') return unitPricePaise <= 100000 ? 5 : 12;
  return rules.defaultTaxRatePercent ?? DEFAULT_GST_PERCENT;
}

/** How the category's default tax reads in a form, e.g. "5% / 12% (apparel slab)" or "18%". */
export function describeTaxDefault(rules: Pick<CategoryRules, 'taxRule' | 'defaultTaxRatePercent'>): string {
  if (rules.taxRule === 'APPAREL_SLAB') return '5% up to ₹1,000, 12% above (apparel slab)';
  return `${rules.defaultTaxRatePercent ?? DEFAULT_GST_PERCENT}%`;
}
