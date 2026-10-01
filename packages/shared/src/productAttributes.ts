import { z } from 'zod';
import type { AttributeDef } from './categoryRules';

// ---------------------------------------------------------------------------
// Product attributes — the spec sheet
//
// A listing's spec sheet is a list of { key, label, value } rows. `key` is the
// stable machine identifier a filter, a facet or a comparison reads
// ("country_of_origin"); `label` is what people see ("Country of origin").
// Keys come from the category's rule when a row fills one of its declared
// fields, and are derived from the label otherwise, so two sellers who both
// type "Power output" produce the same key without having to agree on it.
//
// Rows were stored as { name, value } before this module existed, and clients
// may still send that shape, so every reader goes through
// `normaliseAttributes` and every writer through `canonicalAttributes`.
// ---------------------------------------------------------------------------

/** Same alphabet as a category rule's attribute key. */
export const ATTRIBUTE_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ATTRIBUTE_KEY_MAX_LENGTH = 32;
/** A label such as "5G" yields no leading letter; a key still has to have one. */
const NON_LETTER_KEY_PREFIX = 'x_';
/** A label made entirely of punctuation ("???") leaves nothing to derive from. */
const FALLBACK_ATTRIBUTE_KEY = 'detail';

/** One stored row of the spec sheet. */
export const productAttributeSchema = z.object({
  key: z.string().regex(ATTRIBUTE_KEY_RE),
  label: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(120),
});
export type ProductAttribute = z.infer<typeof productAttributeSchema>;

/**
 * One row as a client sends it. The form submits `key` only for rows that
 * came from the category rule; custom rows carry just a label and the API
 * derives the key. `name` is the pre-canonical spelling of `label`.
 */
export const productAttributeInputSchema = z
  .object({
    key: z.string().regex(ATTRIBUTE_KEY_RE).optional(),
    label: z.string().trim().min(1).max(40).optional(),
    name: z.string().trim().min(1).max(40).optional(),
    value: z.string().trim().min(1).max(120),
  })
  .refine((row) => row.label || row.name, { message: 'Each detail needs a name', path: ['label'] });
export type ProductAttributeInput = z.infer<typeof productAttributeInputSchema>;

/** The display text of a row in either shape. */
export function attributeLabelOf(row: { label?: string; name?: string }): string {
  return (row.label ?? row.name ?? '').trim();
}

/** "Country of origin" → "country_of_origin"; "Power / battery" → "power_battery". */
export function attributeKeyFromLabel(label: string): string {
  let key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!key) key = FALLBACK_ATTRIBUTE_KEY;
  if (!/^[a-z]/.test(key)) key = NON_LETTER_KEY_PREFIX + key;
  return key.slice(0, ATTRIBUTE_KEY_MAX_LENGTH).replace(/_+$/g, '') || FALLBACK_ATTRIBUTE_KEY;
}

/**
 * Does this row fill the given rule field? A row that carries a key is matched
 * on it; one that carries only a label is matched on the label, the way the
 * form has always done.
 */
export function attributeMatchesDef(
  row: { key?: string; label?: string; name?: string },
  def: Pick<AttributeDef, 'key' | 'label'>,
): boolean {
  if (row.key) return row.key === def.key;
  return attributeLabelOf(row).toLowerCase() === def.label.toLowerCase();
}

/**
 * The one shape every write stores: rule-matched rows take the rule's key and
 * label, custom rows keep their label and get a key derived from it.
 *
 * Duplicate keys: the later row wins. The form lists the rule's fields first
 * and the seller's own rows after them, so when a custom row restates a rule
 * field it is the one typed last and most deliberately; refusing the save
 * would block it over a collision the form does not show as one.
 */
export function canonicalAttributes(
  rows: readonly ProductAttributeInput[],
  defs: readonly Pick<AttributeDef, 'key' | 'label'>[] = [],
): ProductAttribute[] {
  const byKey = new Map<string, ProductAttribute>();
  for (const row of rows) {
    const value = row.value.trim();
    const label = attributeLabelOf(row);
    if (!value || !label) continue;
    const def = defs.find((d) => attributeMatchesDef(row, d));
    const canonical: ProductAttribute = def
      ? { key: def.key, label: def.label, value }
      : {
          key: row.key && ATTRIBUTE_KEY_RE.test(row.key) ? row.key : attributeKeyFromLabel(label),
          label,
          value,
        };
    // Re-inserting keeps the first position, so the sheet reads in the order
    // the seller arranged it even when a later row replaced an earlier value.
    byKey.set(canonical.key, canonical);
  }
  return [...byKey.values()];
}

/**
 * Read side: whatever the JSON column holds — canonical rows, legacy
 * { name, value } rows, or junk — as canonical rows, dropping what cannot be
 * rendered. Safe to call on its own output.
 */
export function normaliseAttributes(
  stored: unknown,
  defs: readonly Pick<AttributeDef, 'key' | 'label'>[] = [],
): ProductAttribute[] {
  if (!Array.isArray(stored)) return [];
  const rows: ProductAttributeInput[] = [];
  for (const item of stored) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const label = typeof raw.label === 'string' ? raw.label : typeof raw.name === 'string' ? raw.name : '';
    if (typeof raw.value !== 'string' || !label.trim()) continue;
    rows.push({
      key: typeof raw.key === 'string' && ATTRIBUTE_KEY_RE.test(raw.key) ? raw.key : undefined,
      label,
      value: raw.value,
    });
  }
  return canonicalAttributes(rows, defs);
}

/** Labels of the rule's required fields this sheet leaves empty. */
export function missingRequiredAttributes(
  rows: readonly ProductAttribute[],
  defs: readonly AttributeDef[],
): string[] {
  const filled = new Set(rows.filter((r) => r.value.trim()).map((r) => r.key));
  return defs.filter((d) => d.required && !filled.has(d.key)).map((d) => d.label);
}
