import { colorFamilyOf, facetKeys, type ProductAttribute, type ResolvedFacet } from '@clowe/shared';

/**
 * Reading a product's value for a filter facet.
 *
 * A facet key names a spec-sheet field or a variant option. When the variants
 * carry any of the facet's keys they are read, one value per variant, so
 * "16GB" can be one of a laptop's variants and not the others; a spec-sheet
 * row for the same thing then says less than the variants do, and is not
 * read. Otherwise the first of the keys the spec sheet has gives the whole
 * product one value.
 */

export type FacetFacts = Pick<ResolvedFacet, 'key' | 'alsoKeys' | 'kind' | 'values'>;

export interface FacetReading {
  /** The product's one value, when it comes from the spec sheet. */
  product: string | null;
  /** One value per variant (same order as given), when it comes from the options. */
  variants: (string | null)[] | null;
}

/** A stored value as the facet shows it: a known value whatever its case, a colour as its family. */
export function facetValue(raw: string | undefined | null, facet: FacetFacts, family?: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (facet.kind === 'color') return family?.trim() || colorFamilyOf(value) || value;
  const known = facet.values?.find((v) => v.toLowerCase() === value.toLowerCase());
  return known ?? value;
}

export function readFacet(
  attributes: readonly ProductAttribute[],
  variantOptions: readonly Record<string, string>[],
  facet: FacetFacts,
): FacetReading {
  const keys = facetKeys(facet);
  for (const key of keys) {
    if (variantOptions.some((o) => o[key])) {
      return {
        product: null,
        // The API files every colour's family beside it (color_family).
        variants: variantOptions.map((o) => facetValue(o[key], facet, key === 'color' ? o.color_family : undefined)),
      };
    }
  }
  for (const key of keys) {
    const row = attributes.find((a) => a.key === key);
    if (row) return { product: facetValue(row.value, facet), variants: null };
  }
  return { product: null, variants: null };
}

/** Does the product carry any value for the facet? */
export function hasFacetValue(reading: FacetReading): boolean {
  return reading.product !== null || (reading.variants?.some((v) => v !== null) ?? false);
}
