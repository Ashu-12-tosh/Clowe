import { z } from 'zod';

// ---------------------------------------------------------------------------
// Product variants — generic option axes
//
// A variant is one sellable combination of option values: { size, color } for a
// shirt, { ram, storage, color } for a laptop, {} for a single-SKU product.
// `size` / `color` columns still exist as display caches for the fashion
// catalogue, but `optionValues` is the source of truth everywhere.
// ---------------------------------------------------------------------------

/** One option axis a product's variants differ on. */
export interface VariantAxis {
  /** Machine key: lowercase snake case, e.g. "size", "color", "ram". */
  key: string;
  /** Display label, e.g. "Size", "Colour", "RAM". */
  label: string;
  /** Suggested values for the seller form; free text is still allowed. */
  values?: string[];
}

export const OPTION_KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;
/** A product can differ on at most this many axes. */
export const MAX_VARIANT_AXES = 3;

/** Legacy column values that meant "this axis does not apply". */
const LEGACY_SENTINELS = new Set(['', 'one size', 'standard', 'default', 'n/a', '-', '—']);

/** Well-known axis labels; anything else is title-cased from the key. */
export const AXIS_LABELS: Record<string, string> = {
  size: 'Size',
  color: 'Colour',
  ram: 'RAM',
  storage: 'Storage',
  capacity: 'Capacity',
  format: 'Format',
  language: 'Language',
  flavour: 'Flavour',
  flavor: 'Flavour',
  weight: 'Weight',
  pack_size: 'Pack size',
  material: 'Material',
  screen_size: 'Screen size',
  connectivity: 'Connectivity',
  shade: 'Shade',
  style: 'Style',
  model: 'Model',
  edition: 'Edition',
  platform: 'Platform',
  wattage: 'Wattage',
  volume: 'Volume',
  quantity: 'Quantity',
  length: 'Length',
};

export function axisLabel(key: string): string {
  return AXIS_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const variantAxisSchema = z.object({
  key: z.string().regex(OPTION_KEY_RE, 'Axis keys are lowercase letters, digits and underscores'),
  label: z.string().trim().min(1).max(30),
  values: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
});

/** A variant's option map as it arrives from a client. */
export const optionValuesSchema = z.record(
  z.string().regex(OPTION_KEY_RE, 'Option keys are lowercase letters, digits and underscores'),
  z.string().trim().min(1).max(60),
);

/**
 * Canonical option map. Values are trimmed and empties dropped; the legacy
 * size/colour keys also lose the old "One Size" / "Default" placeholders
 * (whether they arrive in the map or, for pre-marketplace rows, in the columns).
 */
export function normalizeOptionValues(
  values: Record<string, unknown> | null | undefined,
  legacy?: { size?: string | null; color?: string | null },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values ?? {})) {
    if (typeof raw !== 'string' || !OPTION_KEY_RE.test(key)) continue;
    const value = raw.trim();
    if (!value) continue;
    if ((key === 'size' || key === 'color') && LEGACY_SENTINELS.has(value.toLowerCase())) continue;
    out[key] = value;
  }
  if (Object.keys(out).length === 0 && legacy) {
    const size = (legacy.size ?? '').trim();
    const color = (legacy.color ?? '').trim();
    if (!LEGACY_SENTINELS.has(size.toLowerCase())) out.size = size;
    if (!LEGACY_SENTINELS.has(color.toLowerCase())) out.color = color;
  }
  return out;
}

/** Stable identity of an option combination — the DB uniqueness key per product. */
export function optionsKeyOf(values: Record<string, string>): string {
  return Object.keys(values)
    .sort()
    .map((key) => `${key}=${values[key]}`)
    .join('|');
}

/** Keys in reading order: the category's axes first, then colour, size, then the rest. */
export function orderedOptionKeys(values: Record<string, string>, axes: VariantAxis[] = []): string[] {
  const preferred = [...axes.map((a) => a.key), 'color', 'size'].filter(
    (key, i, all) => all.indexOf(key) === i,
  );
  const keys = Object.keys(values);
  return [
    ...preferred.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !preferred.includes(key)).sort(),
  ];
}

/** Human label: "Black · L", "Silver · 16GB · 512GB SSD"; "" for a single-SKU product. */
export function variantLabelOf(values: Record<string, string>, axes: VariantAxis[] = []): string {
  return orderedOptionKeys(values, axes)
    .map((key) => values[key])
    .join(' · ');
}

/** "Colour: Black · Size: L" — for places where bare values would be ambiguous. */
export function variantLabelWithKeys(
  values: Record<string, string>,
  axes: VariantAxis[] = [],
): string {
  return orderedOptionKeys(values, axes)
    .map((key) => `${axisLabel(key)}: ${values[key]}`)
    .join(' · ');
}

/** The axes actually present across a product's variants, ordered like the category's. */
export function axesOf(
  variants: { optionValues: Record<string, string> }[],
  categoryAxes: VariantAxis[] = [],
): VariantAxis[] {
  const union: Record<string, string> = {};
  for (const v of variants) for (const key of Object.keys(v.optionValues)) union[key] = key;
  return orderedOptionKeys(union, categoryAxes).map(
    (key) => categoryAxes.find((a) => a.key === key) ?? { key, label: axisLabel(key) },
  );
}

/** Every column a ProductVariant row derives from its option map. */
export function variantOptionFields(
  values: Record<string, unknown> | null | undefined,
  axes: VariantAxis[] = [],
  legacy?: { size?: string | null; color?: string | null },
): {
  size: string;
  color: string;
  optionValues: Record<string, string>;
  optionsKey: string;
  label: string;
} {
  const optionValues = normalizeOptionValues(values, legacy);
  return {
    size: optionValues.size ?? '',
    color: optionValues.color ?? '',
    optionValues,
    optionsKey: optionsKeyOf(optionValues),
    label: variantLabelOf(optionValues, axes),
  };
}

/** Read a JSON column back into a clean option map. */
export function optionValuesFromJson(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? normalizeOptionValues(value as Record<string, unknown>)
    : {};
}

const SIZE_ORDER = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', 'xxxl', '3xl', '4xl', '5xl', 'free size', 'one size'];

/** Sort option values the way a shopper expects: S < M < L, 8GB < 16GB, then alphabetical. */
export function compareOptionValues(a: string, b: string): number {
  const ia = SIZE_ORDER.indexOf(a.trim().toLowerCase());
  const ib = SIZE_ORDER.indexOf(b.trim().toLowerCase());
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
