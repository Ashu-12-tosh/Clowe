import type { Prisma } from '@prisma/client';
import { normaliseAttributes, suggestSpecValue, type SpecValueSuggestion } from '@clowe/shared';
import { prisma } from '../db';
import { facetsMap } from './categoryRules';

// ---------------------------------------------------------------------------
// Off-list spec values, and the fix an admin approves.
//
// Read-only until approved: findSpecTypos lists every value a seller typed
// that is not on its facet's list, with a suggested match; applySpecFixes
// rewrites only the (key, value) pairs it is given, on the products the
// report flagged for them.
// ---------------------------------------------------------------------------

export interface SpecTypo extends SpecValueSuggestion {
  /** The spec-sheet key the value is stored under. */
  key: string;
  label: string;
  /** As stored (the first spelling seen, when products differ only in case). */
  value: string;
  /** "key:value" — what an admin passes to approve it. */
  token: string;
  productIds: string[];
  /** The facet's known values it was compared against. */
  known: string[];
}

export const specTypoToken = (key: string, value: string) => `${key}:${value.trim().toLowerCase()}`;

/** Every off-list value across the catalog, most products first. */
export async function findSpecTypos(): Promise<SpecTypo[]> {
  const products = await prisma.product.findMany({ select: { id: true, categoryId: true, attributes: true } });
  const facets = await facetsMap([...new Set(products.map((p) => p.categoryId))]);
  const found = new Map<string, { key: string; label: string; value: string; productIds: Set<string>; known: Set<string> }>();

  for (const p of products) {
    const listed = (facets.get(p.categoryId) ?? []).filter((f) => f.values?.length);
    if (listed.length === 0) continue;
    const attributes = normaliseAttributes(p.attributes);
    for (const facet of listed) {
      const known = new Set(facet.values!.map((v) => v.toLowerCase()));
      for (const key of [facet.key, ...(facet.alsoKeys ?? [])]) {
        const row = attributes.find((a) => a.key === key);
        const value = row?.value.trim();
        if (!value || known.has(value.toLowerCase())) continue;
        const token = specTypoToken(key, value);
        const entry = found.get(token) ?? { key, label: facet.label, value, productIds: new Set(), known: new Set() };
        entry.productIds.add(p.id);
        for (const v of facet.values!) entry.known.add(v);
        found.set(token, entry);
      }
    }
  }

  return [...found.entries()]
    .map(([token, e]) => {
      const known = [...e.known];
      return { ...suggestSpecValue(e.value, known), key: e.key, label: e.label, value: e.value, token, productIds: [...e.productIds], known };
    })
    .sort((a, b) => b.productIds.length - a.productIds.length || a.token.localeCompare(b.token));
}

export interface SpecFix {
  key: string;
  /** The off-list value, matched ignoring case and surrounding spaces. */
  from: string;
  /** The known value to write instead. */
  to: string;
  /**
   * The products the report flagged. Only these are rewritten: the same value
   * can be off one category's list and on another's ("Jeans" on a jacket in
   * Winter Wear, and on every pair of jeans in Men).
   */
  productIds: string[];
}

/**
 * Rewrite each approved value on the products the report flagged for it.
 * Only the matching spec row changes; the rest of the sheet is written back as
 * stored. Returns how many products were changed.
 */
export async function applySpecFixes(fixes: SpecFix[]): Promise<number> {
  if (fixes.length === 0) return 0;
  const toFor = new Map<string, Map<string, string>>();
  for (const f of fixes) {
    for (const id of f.productIds) {
      const perProduct = toFor.get(id) ?? new Map<string, string>();
      perProduct.set(specTypoToken(f.key, f.from), f.to);
      toFor.set(id, perProduct);
    }
  }
  const products = await prisma.product.findMany({
    where: { id: { in: [...toFor.keys()] } },
    select: { id: true, attributes: true },
  });
  let changed = 0;
  for (const p of products) {
    if (!Array.isArray(p.attributes)) continue;
    const byToken = toFor.get(p.id)!;
    let touched = false;
    const rows = (p.attributes as Record<string, unknown>[]).map((row) => {
      if (!row || typeof row !== 'object' || typeof row.key !== 'string' || typeof row.value !== 'string') return row;
      const to = byToken.get(specTypoToken(row.key, row.value));
      if (to === undefined) return row;
      touched = true;
      return { ...row, value: to };
    });
    if (!touched) continue;
    await prisma.product.update({ where: { id: p.id }, data: { attributes: rows as Prisma.InputJsonValue } });
    changed += 1;
  }
  return changed;
}
