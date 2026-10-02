import type { Prisma } from '@prisma/client';
import {
  COLOR_FAMILIES,
  COLOR_FAMILY_SWATCH,
  COMMON_FACET_LABELS,
  axisLabel,
  colorFamilyOf,
  compareSizes,
  facetKeys,
  normaliseAttributes,
  optionValuesFromJson,
  type AppliedFilter,
  type FacetRail,
  type PriceFacet,
  type ProductAttribute,
  type ProductSort,
  type RailFacet,
  type RailValue,
  type ResolvedFacet,
} from '@clowe/shared';
import { categoryRows, facetsMap } from './categoryRules';
import { readFacet, type FacetReading } from './facetData';

/**
 * The filter rail: which facets fit a set of products, what each value would
 * leave, and which products survive the filters picked.
 *
 * It works in memory over the products in scope (the category, or what a
 * search found), because every count is "everything else picked, plus this
 * value" — one pass per facet over a few hundred rows is cheaper and far
 * simpler than a query per facet. See measureFacets for the timing.
 *
 * Three rules shape it:
 *
 *   A filter on a variant property (an option, price, discount, stock) holds
 *   for one variant: "M" and "under ₹1,000" means an M that costs under
 *   ₹1,000, not an M at ₹1,500 beside an XL at ₹900.
 *
 *   A product only counts under facets its own category defines. A TV's
 *   `size` option is its screen; in a search across TVs and shirts it must not
 *   turn up as a shirt size.
 *
 *   A facet's own selection is left out of its counts, so choosing one brand
 *   still shows what the others would give.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * A facet the chosen (or guessed) category does not define is shown only when
 * at least this share of what was found carries a value for it. Below a third,
 * most of what a shopper sees in the rail would act on a minority of the page.
 */
export const SHARED_FACET_MIN_COVERAGE = 0.3;

/**
 * A value outside a facet's known list is listed only when at least this many
 * products carry it — so a one-off typo ("hlaf") stays off the rail while the
 * product stays findable, and a real value the list lacks still appears.
 */
export const UNKNOWN_VALUE_MIN_PRODUCTS = 2;

const RATING_STEPS = [4, 3, 2];

/** Bars in the price histogram. */
const PRICE_BARS = 20;

/**
 * When the dearest variant costs more than this many times the cheapest, the
 * bars are spaced on a log scale. ₹180 to ₹1.6 lakh in equal steps puts
 * nearly the whole catalog in the first bar, and the slider, which moves bar
 * by bar, could not tell ₹500 from ₹5,000.
 */
const LOG_SCALE_ABOVE = 20;

/** Bar edges rounded to steps a shopper would type: ₹10 under ₹1,000, then ₹50, ₹500, ₹1,000. */
function niceRupees(paise: number): number {
  const rupees = paise / 100;
  const step = rupees < 1_000 ? 10 : rupees < 10_000 ? 50 : rupees < 100_000 ? 500 : 1_000;
  return Math.round(rupees / step) * step * 100;
}

/** Edges for the histogram: PRICE_BARS + 1 ascending values from min to max (fewer if they collapse). */
export function priceEdges(minPaise: number, maxPaise: number): number[] {
  if (maxPaise <= minPaise) return [minPaise, maxPaise];
  const log = maxPaise / Math.max(minPaise, 1) > LOG_SCALE_ABOVE;
  const edges = [minPaise];
  for (let i = 1; i < PRICE_BARS; i += 1) {
    const t = i / PRICE_BARS;
    const raw = log
      ? Math.exp(Math.log(Math.max(minPaise, 1)) + t * (Math.log(maxPaise) - Math.log(Math.max(minPaise, 1))))
      : minPaise + t * (maxPaise - minPaise);
    const edge = niceRupees(raw);
    if (edge > edges[edges.length - 1] && edge < maxPaise) edges.push(edge);
  }
  edges.push(maxPaise);
  return edges;
}

/** Option keys the API writes for itself, never a facet of their own. */
const INTERNAL_OPTION_KEYS = new Set(['color_family']);

/**
 * An option axis a product's variants carry that its category's facets do not
 * read (as a key or an alsoKey): a seller's own axis, or a category with no
 * facets set at all. It is offered like any facet, subject to the same
 * coverage rule, so a rail never loses what the variants can be told apart by.
 */
function autoFacets(p: EngineProduct, defined: ResolvedFacet[]): ResolvedFacet[] {
  const read = new Set(defined.flatMap((d) => facetKeys(d)));
  const keys = new Set(p.variants.flatMap((v) => Object.keys(v.options)));
  return [...keys]
    .filter((key) => !read.has(key) && !INTERNAL_OPTION_KEYS.has(key))
    .map((key) => ({
      key,
      label: axisLabel(key),
      kind: key === 'size' ? 'size' : key === 'color' ? 'color' : 'list',
      fromCategoryId: p.categoryId,
    }));
}
const DISCOUNT_STEPS = [10, 20, 30, 40, 50];

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface RailFilters {
  /** Facet key → selected values, as given (compared ignoring case). */
  facets: Map<string, string[]>;
  brands: string[];
  minRating: number | null;
  minDiscount: number | null;
  inStock: boolean;
  minPaise: number | null;
  maxPaise: number | null;
}

export const NO_FILTERS: RailFilters = {
  facets: new Map(),
  brands: [],
  minRating: null,
  minDiscount: null,
  inStock: false,
  minPaise: null,
  maxPaise: null,
};

export interface EngineProduct {
  id: string;
  categoryId: string;
  brand: string | null;
  ratingAvg: number;
  ratingCount: number;
  soldCount: number;
  createdAt: Date;
  mrpPaise: number | null;
  attributes: ProductAttribute[];
  variants: { id: string; options: Record<string, string>; pricePaise: number; mrpPaise: number | null; stock: number }[];
}

/** What the engine reads of a product. */
export const ENGINE_SELECT = {
  id: true,
  categoryId: true,
  brand: true,
  ratingAvg: true,
  ratingCount: true,
  soldCount: true,
  createdAt: true,
  mrpPaise: true,
  attributes: true,
  brandRef: { select: { name: true } },
  variants: { select: { id: true, optionValues: true, pricePaise: true, mrpPaise: true, stock: true } },
} satisfies Prisma.ProductSelect;

export function toEngineProduct(row: Prisma.ProductGetPayload<{ select: typeof ENGINE_SELECT }>): EngineProduct {
  return {
    id: row.id,
    categoryId: row.categoryId,
    // A linked brand's own spelling, so "zephyr" and "Zephyr" are one value.
    brand: row.brandRef?.name ?? row.brand,
    ratingAvg: row.ratingAvg,
    ratingCount: row.ratingCount,
    soldCount: row.soldCount,
    createdAt: row.createdAt,
    mrpPaise: row.mrpPaise,
    attributes: normaliseAttributes(row.attributes),
    variants: row.variants.map((v) => ({
      id: v.id,
      options: optionValuesFromJson(v.optionValues),
      pricePaise: v.pricePaise,
      mrpPaise: v.mrpPaise,
      stock: v.stock,
    })),
  };
}

export interface EngineInput {
  /** The scope, in the order to keep when `sort` is null (a search's ranking). */
  products: EngineProduct[];
  filters: RailFilters;
  /** The category picked or guessed: its facets come first, whatever their coverage. */
  preferredCategoryId: string | null;
  basisKind: FacetRail['basis']['kind'];
  /** Reorder the matches; null keeps the input order. */
  sort: ProductSort | null;
}

export interface EngineResult {
  /** Matching products, in order. */
  ids: string[];
  /** Per matching product, the variants that satisfied every variant filter. */
  matchedVariants: Map<string, string[]>;
  /** Matching products per category id. */
  categoryCounts: Map<string, number>;
  rail: FacetRail;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** A predicate to leave out: one facet's own (`f:<key>`) or a common one. */
type Skip = null | 'brand' | 'rating' | 'discount' | 'inStock' | 'price' | `f:${string}`;

interface Prepared {
  p: EngineProduct;
  /** Facets its category defines, by key. */
  defs: Map<string, ResolvedFacet>;
  readings: Map<string, FacetReading>;
  /** Percent off MRP per variant, 0 when there is no MRP above the price. */
  discounts: number[];
}

const lower = (v: string | null) => (v === null ? null : v.toLowerCase());

/** The selected values per facet key, lower-cased for comparing. */
type Wanted = Map<string, Set<string>>;

function productLevelOk(x: Prepared, f: RailFilters, wantedBy: Wanted, brands: Set<string>, skip: Skip): boolean {
  if (skip !== 'brand' && brands.size && !(x.p.brand && brands.has(x.p.brand.toLowerCase()))) return false;
  if (skip !== 'rating' && f.minRating !== null && !(x.p.ratingCount > 0 && x.p.ratingAvg >= f.minRating)) return false;
  for (const [key, wanted] of wantedBy) {
    if (skip === `f:${key}`) continue;
    const r = x.readings.get(key);
    if (!r || (r.product === null && r.variants === null)) return false;
    if (r.product !== null && !wanted.has(r.product.toLowerCase())) return false;
  }
  return true;
}

function variantMask(x: Prepared, f: RailFilters, wantedBy: Wanted, skip: Skip): boolean[] {
  return x.p.variants.map((v, i) => {
    if (skip !== 'price') {
      if (f.minPaise !== null && v.pricePaise < f.minPaise) return false;
      if (f.maxPaise !== null && v.pricePaise > f.maxPaise) return false;
    }
    if (skip !== 'inStock' && f.inStock && v.stock <= 0) return false;
    if (skip !== 'discount' && f.minDiscount !== null && x.discounts[i] < f.minDiscount) return false;
    for (const [key, wanted] of wantedBy) {
      if (skip === `f:${key}`) continue;
      const values = x.readings.get(key)?.variants;
      if (values && !wanted.has(lower(values[i]) ?? '')) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface MergedFacet {
  def: ResolvedFacet;
  preferred: boolean;
  /** Known values from every category that defines the key, the preferred one's first. */
  values: string[];
}

export async function runFacetEngine(input: EngineInput): Promise<EngineResult> {
  const { filters } = input;
  const brands = new Set(filters.brands.map((b) => b.toLowerCase()));
  const wantedBy: Wanted = new Map([...filters.facets].map(([k, vs]) => [k, new Set(vs.map((v) => v.toLowerCase()))]));
  const index = await facetsMap(input.products.map((p) => p.categoryId));
  const preferredDefs = input.preferredCategoryId ? (await facetsMap([input.preferredCategoryId])).get(input.preferredCategoryId)! : [];

  const prepared: Prepared[] = input.products.map((p) => {
    const defined = index.get(p.categoryId) ?? [];
    const defs = new Map([...defined, ...autoFacets(p, defined)].map((d) => [d.key, d]));
    const readings = new Map<string, FacetReading>();
    const options = p.variants.map((v) => v.options);
    for (const [key, def] of defs) readings.set(key, readFacet(p.attributes, options, def));
    const discounts = p.variants.map((v) => {
      const mrp = v.mrpPaise ?? p.mrpPaise;
      return mrp && mrp > v.pricePaise ? Math.floor(((mrp - v.pricePaise) * 100) / mrp) : 0;
    });
    return { p, defs, readings, discounts };
  });

  /** Products passing everything but `skip`, each with the variants that pass too. */
  const passing = (skip: Skip) =>
    prepared.flatMap((x) => {
      if (!productLevelOk(x, filters, wantedBy, brands, skip)) return [];
      const mask = variantMask(x, filters, wantedBy, skip);
      return mask.some(Boolean) ? [{ x, mask }] : [];
    });

  // --- What matches -------------------------------------------------------
  const matches = passing(null);
  const priceOf = (m: { x: Prepared; mask: boolean[] }) =>
    Math.min(...m.x.p.variants.filter((_, i) => m.mask[i]).map((v) => v.pricePaise));
  const ordered = input.sort ? [...matches].sort(sortBy(input.sort, priceOf)) : matches;
  const matchedVariants = new Map(ordered.map((m) => [m.x.p.id, m.x.p.variants.filter((_, i) => m.mask[i]).map((v) => v.id)]));
  const categoryCounts = new Map<string, number>();
  for (const m of ordered) categoryCounts.set(m.x.p.categoryId, (categoryCounts.get(m.x.p.categoryId) ?? 0) + 1);

  // --- Which facets ------------------------------------------------------------
  const merged = new Map<string, MergedFacet>();
  for (const def of preferredDefs) merged.set(def.key, { def, preferred: true, values: [...(def.values ?? [])] });
  // Other categories' definitions, the one most of the scope uses first.
  const productsPerCategory = new Map<string, number>();
  for (const x of prepared) productsPerCategory.set(x.p.categoryId, (productsPerCategory.get(x.p.categoryId) ?? 0) + 1);
  const byUse = [...productsPerCategory.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const defsInUse = new Map<string, ResolvedFacet[]>();
  for (const x of prepared) {
    const list = defsInUse.get(x.p.categoryId) ?? [];
    for (const def of x.defs.values()) if (!list.some((d) => d.key === def.key)) list.push(def);
    defsInUse.set(x.p.categoryId, list);
  }
  for (const categoryId of byUse) {
    for (const def of defsInUse.get(categoryId) ?? []) {
      const known = merged.get(def.key);
      if (!known) merged.set(def.key, { def, preferred: false, values: [...(def.values ?? [])] });
      else for (const v of def.values ?? []) if (!known.values.includes(v)) known.values.push(v);
    }
  }

  const facets: RailFacet[] = [];
  const coverageOf = new Map<string, number>();
  for (const [key, facet] of merged) {
    const wanted = filters.facets.get(key) ?? [];
    const base = passing(`f:${key}`);
    const counts = new Map<string, number>();
    const members = new Map<string, Set<string>>();
    let withValue = 0;
    for (const { x, mask } of base) {
      const r = x.readings.get(key);
      if (!r) continue;
      const values = new Set<string>();
      if (r.product !== null) values.add(r.product);
      r.variants?.forEach((v, i) => {
        if (v !== null && mask[i]) values.add(v);
      });
      if (values.size) withValue += 1;
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      if (facet.def.kind === 'color') collectMembers(x, facet.def, mask, members);
    }
    const coverage = base.length ? withValue / base.length : 0;
    coverageOf.set(key, coverage);
    const selected = wanted.length > 0;
    if (!selected && counts.size < 2) continue;
    if (!selected && !facet.preferred && coverage < SHARED_FACET_MIN_COVERAGE) continue;
    facets.push({
      key,
      label: facet.def.label,
      kind: facet.def.kind,
      param: `f[${key}]`,
      multi: true,
      values: railValues(facet, counts, wanted, members),
    });
  }
  // The picked or guessed category's order first, then by how much of the page each one covers.
  const preferredOrder = preferredDefs.map((d) => d.key);
  facets.sort((a, b) => {
    const pa = preferredOrder.indexOf(a.key);
    const pb = preferredOrder.indexOf(b.key);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? Infinity : pa) - (pb === -1 ? Infinity : pb);
    return (coverageOf.get(b.key) ?? 0) - (coverageOf.get(a.key) ?? 0) || a.label.localeCompare(b.label);
  });

  // --- The facets every rail has -------------------------------------------
  const common: RailFacet[] = [];
  const brandCounts = new Map<string, number>();
  for (const { x } of passing('brand')) if (x.p.brand) brandCounts.set(x.p.brand, (brandCounts.get(x.p.brand) ?? 0) + 1);
  for (const b of filters.brands) if (![...brandCounts.keys()].some((k) => k.toLowerCase() === b.toLowerCase())) brandCounts.set(b, 0);
  common.push({
    key: 'brand',
    label: COMMON_FACET_LABELS.brand,
    kind: 'list',
    param: 'brands',
    multi: true,
    values: [...brandCounts.entries()]
      .map(([name, count]) => ({ value: name, label: name, count, selected: brands.has(name.toLowerCase()) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  });

  const rated = passing('rating');
  common.push({
    key: 'rating',
    label: COMMON_FACET_LABELS.rating,
    kind: 'rating',
    param: 'rating',
    multi: false,
    values: RATING_STEPS.map((step) => ({
      value: String(step),
      label: `${step}★ & up`,
      count: rated.filter(({ x }) => x.p.ratingCount > 0 && x.p.ratingAvg >= step).length,
      selected: filters.minRating === step,
    })).filter((v) => v.count > 0 || v.selected),
  });

  const discounted = passing('discount');
  common.push({
    key: 'discount',
    label: COMMON_FACET_LABELS.discount,
    kind: 'discount',
    param: 'discount',
    multi: false,
    values: DISCOUNT_STEPS.map((step) => ({
      value: String(step),
      label: `${step}% off or more`,
      count: discounted.filter(({ x, mask }) => x.discounts.some((d, i) => mask[i] && d >= step)).length,
      selected: filters.minDiscount === step,
    })).filter((v) => v.count > 0 || v.selected),
  });

  const stocked = passing('inStock');
  common.push({
    key: 'inStock',
    label: COMMON_FACET_LABELS.inStock,
    kind: 'toggle',
    param: 'inStock',
    multi: false,
    values: [
      {
        value: '1',
        label: 'In stock only',
        count: stocked.filter(({ x, mask }) => x.p.variants.some((v, i) => mask[i] && v.stock > 0)).length,
        selected: filters.inStock,
      },
    ],
  });

  // --- Price ---------------------------------------------------------------
  const priced = passing('price');
  let price: PriceFacet | null = null;
  if (priced.length) {
    // Bounds over every variant the other filters leave, so the slider spans
    // what could still be chosen.
    const prices = priced.flatMap(({ x, mask }) => x.p.variants.filter((_, i) => mask[i]).map((v) => v.pricePaise));
    const minPaise = Math.min(...prices);
    const maxPaise = Math.max(...prices);
    const edges = priceEdges(minPaise, maxPaise);
    const bars = edges.slice(0, -1).map((from, i) => ({ fromPaise: from, toPaise: edges[i + 1], count: 0 }));
    // A product counts once in each bar one of its variants falls in.
    for (const { x, mask } of priced) {
      const hit = new Set<number>();
      x.p.variants.forEach((v, i) => {
        if (!mask[i]) return;
        const bar = bars.findIndex((b, j) => v.pricePaise >= b.fromPaise && (v.pricePaise < b.toPaise || j === bars.length - 1));
        if (bar !== -1) hit.add(bar);
      });
      for (const bar of hit) bars[bar].count += 1;
    }
    price = {
      minPaise,
      maxPaise,
      histogram: bars,
      selectedMinPaise: filters.minPaise,
      selectedMaxPaise: filters.maxPaise,
    };
  }

  const rows = await categoryRows();
  const preferredName = input.preferredCategoryId ? (rows.get(input.preferredCategoryId)?.name ?? null) : null;
  // Two departments' "Type" side by side would be ambiguous: name the department.
  const labelCount = new Map<string, number>();
  for (const f of facets) labelCount.set(f.label, (labelCount.get(f.label) ?? 0) + 1);
  for (const f of facets) {
    if ((labelCount.get(f.label) ?? 0) < 2) continue;
    const from = rows.get(merged.get(f.key)!.def.fromCategoryId)?.name;
    if (from) f.label = `${f.label} · ${from}`;
  }
  const railFacets = [...facets, ...common.filter((f) => f.values.length > 0)];
  return {
    ids: ordered.map((m) => m.x.p.id),
    matchedVariants,
    categoryCounts,
    rail: {
      facets: railFacets,
      price,
      applied: appliedChips(filters, railFacets, merged),
      basis: { kind: input.basisKind, categoryName: preferredName },
    },
  };
}

function sortBy(sort: ProductSort, priceOf: (m: { x: Prepared; mask: boolean[] }) => number) {
  type M = { x: Prepared; mask: boolean[] };
  const tie = (a: M, b: M) => a.x.p.id.localeCompare(b.x.p.id);
  switch (sort) {
    case 'popularity':
      return (a: M, b: M) => b.x.p.soldCount - a.x.p.soldCount || tie(a, b);
    case 'price_asc':
      return (a: M, b: M) => priceOf(a) - priceOf(b) || tie(a, b);
    case 'price_desc':
      return (a: M, b: M) => priceOf(b) - priceOf(a) || tie(a, b);
    case 'rating':
      return (a: M, b: M) => b.x.p.ratingAvg - a.x.p.ratingAvg || b.x.p.ratingCount - a.x.p.ratingCount || tie(a, b);
    case 'newest':
    default:
      return (a: M, b: M) => b.x.p.createdAt.getTime() - a.x.p.createdAt.getTime() || tie(a, b);
  }
}

/** The colour names a family stands for, as sellers wrote them. */
function collectMembers(x: Prepared, def: ResolvedFacet, mask: boolean[], into: Map<string, Set<string>>) {
  const add = (raw: string | undefined, family?: string) => {
    const name = raw?.trim();
    if (!name) return;
    const fam = family?.trim() || colorFamilyOf(name) || name;
    const set = into.get(fam) ?? new Set<string>();
    set.add(name);
    into.set(fam, set);
  };
  for (const key of facetKeys(def)) {
    if (x.p.variants.some((v) => v.options[key])) {
      x.p.variants.forEach((v, i) => {
        if (mask[i]) add(v.options[key], key === 'color' ? v.options.color_family : undefined);
      });
      return;
    }
  }
  for (const key of facetKeys(def)) {
    const row = x.p.attributes.find((a) => a.key === key);
    if (row) return add(row.value);
  }
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function railValues(
  facet: MergedFacet,
  counts: Map<string, number>,
  selectedValues: string[],
  members: Map<string, Set<string>>,
): RailValue[] {
  const kind = facet.def.kind;
  const wanted = new Set(selectedValues.map((v) => v.toLowerCase()));
  const all = new Map(counts);
  // A selected value stays listed even when nothing has it now, so it can be removed.
  for (const w of selectedValues) if (![...all.keys()].some((k) => k.toLowerCase() === w.toLowerCase())) all.set(w, 0);
  const knownLower = facet.values.map((v) => v.toLowerCase());
  const entries = [...all.entries()].filter(([value, count]) => {
    if (wanted.has(value.toLowerCase())) return true;
    if (kind === 'color' || !knownLower.length) return count > 0;
    return knownLower.includes(value.toLowerCase()) ? count > 0 : count >= UNKNOWN_VALUE_MIN_PRODUCTS;
  });
  const rank = (value: string): number => {
    if (kind === 'color') {
      const i = (COLOR_FAMILIES as readonly string[]).indexOf(value);
      return i === -1 ? COLOR_FAMILIES.length : i;
    }
    const i = knownLower.indexOf(value.toLowerCase());
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  entries.sort(([a, ca], [b, cb]) => {
    if (kind === 'size') return compareSizes(a, b);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    // Open-ended lists (author, fabric): the most common first.
    return cb - ca || naturalCompare(a, b);
  });
  return entries.map(([value, count]) => ({
    value,
    label: value,
    count,
    selected: wanted.has(value.toLowerCase()),
    ...(kind === 'color'
      ? {
          swatch: (COLOR_FAMILY_SWATCH as Record<string, string | null>)[value] ?? null,
          members: [...(members.get(value) ?? [])].sort(naturalCompare),
        }
      : {}),
  }));
}

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

function appliedChips(filters: RailFilters, facets: RailFacet[], merged: Map<string, MergedFacet>): AppliedFilter[] {
  const chips: AppliedFilter[] = [];
  for (const [key, wanted] of filters.facets) {
    const facet = facets.find((f) => f.key === key);
    const label = facet?.label ?? merged.get(key)?.def.label ?? key;
    for (const w of wanted) {
      const value = facet?.values.find((v) => v.value.toLowerCase() === w.toLowerCase())?.value ?? w;
      chips.push({ param: `f[${key}]`, value, label: `${label}: ${value}` });
    }
  }
  for (const b of filters.brands) chips.push({ param: 'brands', value: b, label: b });
  if (filters.minPaise !== null || filters.maxPaise !== null) {
    const label =
      filters.minPaise !== null && filters.maxPaise !== null
        ? `${rupees(filters.minPaise)} – ${rupees(filters.maxPaise)}`
        : filters.minPaise !== null
          ? `Over ${rupees(filters.minPaise)}`
          : `Under ${rupees(filters.maxPaise!)}`;
    chips.push({ param: 'price', value: '', label });
  }
  if (filters.minRating !== null) chips.push({ param: 'rating', value: String(filters.minRating), label: `${filters.minRating}★ & up` });
  if (filters.minDiscount !== null) {
    chips.push({ param: 'discount', value: String(filters.minDiscount), label: `${filters.minDiscount}% off or more` });
  }
  if (filters.inStock) chips.push({ param: 'inStock', value: '1', label: 'In stock' });
  return chips;
}
