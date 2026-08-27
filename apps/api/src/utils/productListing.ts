/** Shared bits for building ProductListItem across listings, ads and wishlist. */

interface VariantLike {
  id: string;
  pricePaise: number;
  stock: number;
}

/**
 * Cheapest variant that is actually in stock — what a listing card adds to the
 * cart in one tap. Null when every variant is sold out.
 */
export function defaultVariantOf<T extends VariantLike>(variants: T[]): T | null {
  return variants
    .filter((v) => v.stock > 0)
    .reduce<T | null>((min, v) => (!min || v.pricePaise < min.pricePaise ? v : min), null);
}

/** The `defaultVariantId` / `inStock` pair every ProductListItem carries. */
export function listingStockFields<T extends VariantLike>(
  variants: T[],
): { defaultVariantId: string | null; inStock: boolean } {
  const variant = defaultVariantOf(variants);
  return { defaultVariantId: variant?.id ?? null, inStock: variant !== null };
}
