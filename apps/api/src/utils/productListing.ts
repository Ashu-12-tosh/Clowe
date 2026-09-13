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
export function toProductListItem(p: ListingProduct): ProductListItem {
  const cheapest = p.variants.reduce<{ pricePaise: number; mrpPaise: number | null }>(
    (min, v) => (v.pricePaise < min.pricePaise ? v : min),
    p.variants[0] ?? { pricePaise: p.basePricePaise, mrpPaise: null },
  );
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    brand: p.brand,
    categoryName: p.category.name,
    pricePaise: cheapest.pricePaise,
    mrpPaise: p.mrpPaise ?? cheapest.mrpPaise,
    imageUrl: p.images[0]?.url ?? null,
    // size/color are display caches of optionValues — "" when the axis is absent.
    sizes: [...new Set(p.variants.map((v) => v.size).filter(Boolean))],
    colors: [...new Set(p.variants.map((v) => v.color).filter(Boolean))],
    // Denormalised rating cache — synced on every review write.
    ratingAvg: p.ratingCount > 0 ? p.ratingAvg : null,
    ratingCount: p.ratingCount,
    ...listingStockFields(p.variants),
  };
}
