/** Shared bits for building ProductListItem across listings, ads and wishlist. */
import type { ProductListItem } from '@clowe/shared';

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

/**
 * Whether the variants disagree on price — what turns a card's "₹499" into
 * "from ₹499".
 *
 * Shared rather than rewritten per surface: listings, ads and the wishlist all
 * build the same card, and a card that says "from" in one place and not another
 * for the same product is worse than either answer on its own.
 */
export function pricesVary(variants: { pricePaise: number }[]): boolean {
  if (variants.length < 2) return false;
  const first = variants[0]!.pricePaise;
  return variants.some((v) => v.pricePaise !== first);
}

/** The `defaultVariantId` / `inStock` pair every ProductListItem carries. */
export function listingStockFields<T extends VariantLike>(
  variants: T[],
): { defaultVariantId: string | null; inStock: boolean } {
  const variant = defaultVariantOf(variants);
  return { defaultVariantId: variant?.id ?? null, inStock: variant !== null };
}

/** Shape a ProductListItem is built from — matches `productListItemInclude`. */
export interface ListingProduct {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  mrpPaise: number | null;
  basePricePaise: number;
  ratingAvg: number;
  ratingCount: number;
  category: { name: string };
  images: { url: string }[];
  variants: {
    id: string;
    size: string;
    color: string;
    pricePaise: number;
    mrpPaise: number | null;
    stock: number;
  }[];
}

/** Prisma `include` that loads exactly what toProductListItem needs. */
export const productListItemInclude = {
  category: { select: { name: true } },
  images: { orderBy: { sortOrder: 'asc' }, take: 1 },
  variants: {
    select: { id: true, size: true, color: true, pricePaise: true, mrpPaise: true, stock: true },
  },
} as const;

/**
 * Map a loaded product to the card shape every listing surface renders.
 * Price comes from the cheapest variant (not the cheapest *in-stock* one — a
 * sold-out card still shows what it costs); defaultVariantId is the in-stock one.
 */
export function toProductListItem(p: ListingProduct, matchedVariantIds?: readonly string[]): ProductListItem {
  // With filters on variants (a price range, a size), the card speaks for the
  // variants that matched: their cheapest price, and one of them to add.
  const matched = matchedVariantIds ? p.variants.filter((v) => matchedVariantIds.includes(v.id)) : [];
  const shown = matched.length ? matched : p.variants;
  const cheapest = shown.reduce<{ pricePaise: number; mrpPaise: number | null }>(
    (min, v) => (v.pricePaise < min.pricePaise ? v : min),
    shown[0] ?? { pricePaise: p.basePricePaise, mrpPaise: null },
  );
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    brand: p.brand,
    categoryName: p.category.name,
    pricePaise: cheapest.pricePaise,
    mrpPaise: p.mrpPaise ?? cheapest.mrpPaise,
    priceVaries: pricesVary(shown),
    imageUrl: p.images[0]?.url ?? null,
    // size/color are display caches of optionValues — "" when the axis is absent.
    sizes: [...new Set(p.variants.map((v) => v.size).filter(Boolean))],
    colors: [...new Set(p.variants.map((v) => v.color).filter(Boolean))],
    // Denormalised rating cache — synced on every review write.
    ratingAvg: p.ratingCount > 0 ? p.ratingAvg : null,
    ratingCount: p.ratingCount,
    // Prefer a matching variant in stock; fall back to any in stock.
    ...(matched.length && listingStockFields(matched).inStock ? listingStockFields(matched) : listingStockFields(p.variants)),
  };
}
