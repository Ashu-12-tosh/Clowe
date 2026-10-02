import { z } from 'zod';
import type { AttributeDef } from './categoryRules';

// ---------------------------------------------------------------------------
// Filter facets — what a shopper can narrow a listing or a search by.
//
// Facet definitions are data on the category tree, not code: each category
// stores what it adds to its parent's set, what it hides of it, and in what
// order, and a category's facets are its ancestors' with those edits applied,
// root first. Admins edit them; the seed only fills categories nobody has.
//
// A facet key names a spec-sheet field (`processor`) or a variant option axis
// (`ram`), and is read from both: a product counts under the first of `key`
// and `alsoKeys` it carries, in its spec sheet or on its variants. So the same
// facet works whether a seller listed RAM as one fixed spec or as variants,
// and TVs that call their screen `size` and TVs that call it `screen` both
// land in Screen size.
//
// Price, brand, customer rating, discount and availability are on every rail
// and are not stored per category (COMMON_FACETS).
// ---------------------------------------------------------------------------

/** How a facet's values are shown and ordered. */
export const FACET_KINDS = ['list', 'color', 'size'] as const;
export type FacetKind = (typeof FACET_KINDS)[number];

export const FACET_KIND_LABELS: Record<FacetKind, string> = {
  list: 'List',
  color: 'Colour (grouped by family)',
  size: 'Size (sorted by scale)',
};

/** Same alphabet as a spec-sheet key or an option axis. */
export const FACET_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * The spec sheet a seller fills in for a category: its own fields, then one
 * for each facet that is not a variant axis there, and a dropdown wherever a
 * facet knows the values — the same values the filter rail lists, so what a
 * seller picks is what a shopper filters by.
 */
export function specFieldsFor(
  rules: { attributeSchema: readonly AttributeDef[]; variantAxes: readonly { key: string }[] },
  facets: readonly ResolvedFacet[],
): AttributeDef[] {
  const axes = new Set(rules.variantAxes.map((a) => a.key));
  const byKey = new Map(facets.map((f) => [f.key, f]));
  const fields: AttributeDef[] = rules.attributeSchema.map((def) => {
    const values = byKey.get(def.key)?.values;
    if (!values?.length) return def;
    return { ...def, type: 'select', options: [...values, ...(def.options ?? []).filter((o) => !values.includes(o))] };
  });
  for (const facet of facets) {
    // Colours and the category's own axes are set per variant, not on the sheet.
    if (facet.kind === 'color' || facetKeys(facet).some((k) => axes.has(k))) continue;
    if (fields.some((f) => f.key === facet.key)) continue;
    fields.push(
      facet.values?.length
        ? { key: facet.key, label: facet.label, type: 'select', options: [...facet.values] }
        : { key: facet.key, label: facet.label, type: 'text' },
    );
  }
  return fields;
}

/** The rail entries every listing has, whatever the category. Not stored per category. */
export const COMMON_FACETS = ['price', 'brand', 'rating', 'discount', 'inStock'] as const;
export type CommonFacet = (typeof COMMON_FACETS)[number];

export const COMMON_FACET_LABELS: Record<CommonFacet, string> = {
  price: 'Price',
  brand: 'Brand',
  rating: 'Customer rating',
  discount: 'Discount',
  inStock: 'Availability',
};

/** Keys a category facet may not take: the common facets' own names. */
export const RESERVED_FACET_KEYS: readonly string[] = [...COMMON_FACETS, 'category', 'q', 'sort', 'page'];

export const facetDefSchema = z.object({
  key: z.string().regex(FACET_KEY_RE, 'Lowercase letters, digits and _ only, starting with a letter'),
  label: z.string().trim().min(1).max(40),
  kind: z.enum(FACET_KINDS).default('list'),
  /**
   * The known values, in the order a shopper reads them. Sellers pick from
   * these in the spec sheet; a stored value that matches one (ignoring case)
   * is counted under it.
   */
  values: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
  /** Other keys holding the same thing, read when a product lacks `key`. */
  alsoKeys: z.array(z.string().regex(FACET_KEY_RE)).max(5).optional(),
});
export type FacetDef = z.infer<typeof facetDefSchema>;

/** What one category stores. null on the category means "exactly as the parent". */
export const categoryFacetConfigSchema = z
  .object({
    /** Facets this category adds, or replaces by key. */
    add: z.array(facetDefSchema).max(20).default([]),
    /** Inherited keys this category does not show. */
    hide: z.array(z.string().regex(FACET_KEY_RE)).max(40).default([]),
    /** Display order by key; keys not named keep their order after these. */
    order: z.array(z.string().regex(FACET_KEY_RE)).max(40).optional(),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.add.forEach((def, i) => {
      if (RESERVED_FACET_KEYS.includes(def.key)) {
        ctx.addIssue({ code: 'custom', path: ['add', i, 'key'], message: `"${def.key}" is on every rail already` });
      }
      if (seen.has(def.key)) {
        ctx.addIssue({ code: 'custom', path: ['add', i, 'key'], message: `"${def.key}" is listed twice` });
      }
      seen.add(def.key);
    });
  });
export type CategoryFacetConfig = z.infer<typeof categoryFacetConfigSchema>;

/** A facet as it applies to one category, and which category it came from. */
export interface ResolvedFacet extends FacetDef {
  kind: FacetKind;
  /** The category whose definition this is (the nearest one that set it). */
  fromCategoryId: string;
}

/** Read the stored JSON; anything malformed counts as "no own config". */
export function facetConfigFromJson(value: unknown): CategoryFacetConfig | null {
  if (value === null || value === undefined) return null;
  const parsed = categoryFacetConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The facets of the last category in `chain` (ordered root first): start
 * empty, and at each level drop what it hides, add or replace what it adds,
 * then apply its order.
 */
export function resolveFacets(chain: { id: string; config: CategoryFacetConfig | null }[]): ResolvedFacet[] {
  let list: ResolvedFacet[] = [];
  for (const node of chain) {
    const config = node.config;
    if (!config) continue;
    const hidden = new Set(config.hide);
    list = list.filter((f) => !hidden.has(f.key));
    for (const def of config.add) {
      const entry: ResolvedFacet = { ...def, kind: def.kind ?? 'list', fromCategoryId: node.id };
      const at = list.findIndex((f) => f.key === def.key);
      if (at === -1) list.push(entry);
      else list[at] = entry;
    }
    if (config.order?.length) {
      const order = config.order;
      const rank = (key: string, index: number) => {
        const i = order.indexOf(key);
        return i === -1 ? order.length + index : i;
      };
      list = list
        .map((facet, index) => ({ facet, rank: rank(facet.key, index) }))
        .sort((a, b) => a.rank - b.rank)
        .map((x) => x.facet);
    }
  }
  return list;
}

/** Every key a facet reads, its own first. */
export function facetKeys(def: Pick<FacetDef, 'key' | 'alsoKeys'>): string[] {
  return [def.key, ...(def.alsoKeys ?? [])];
}

// ---------------------------------------------------------------------------
// Admin: one category's facets, and what its children end up with
// ---------------------------------------------------------------------------

export interface AdminFacetRow extends ResolvedFacet {
  /** Name of the category the definition comes from. */
  fromCategoryName: string;
  /** Live products in this category (and below) that carry a value for it. */
  productsWithValue: number;
}

export interface AdminCategoryFacets {
  category: { id: string; name: string; slug: string; path: { id: string; name: string }[] };
  /** What this category stores; null = exactly as its parent. */
  own: CategoryFacetConfig | null;
  /** What the parent passes down, before this category's edits. */
  inherited: AdminFacetRow[];
  /** What shoppers see here. */
  resolved: AdminFacetRow[];
  /** Live products in this category and below. */
  liveProducts: number;
  /** Direct children, and the facets each ends up with. */
  children: { id: string; name: string; slug: string; hasOwn: boolean; facets: { key: string; label: string }[] }[];
}

export const categoryFacetsUpdateSchema = z.object({
  /** null clears the category's own config, so it inherits its parent's set unchanged. */
  config: categoryFacetConfigSchema.nullable(),
});
