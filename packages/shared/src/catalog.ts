import { z } from 'zod';

// ---------------------------------------------------------------------------
// Product listing query (shared by API validation and web client)
// ---------------------------------------------------------------------------

export const productSortValues = ['newest', 'price_asc', 'price_desc'] as const;
export type ProductSort = (typeof productSortValues)[number];

/** Query params for GET /api/products. Comma-separated lists for sizes/colors. */
export const productListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().optional(), // category slug (includes children)
  sizes: z.string().trim().optional(), // e.g. "S,M,L"
  colors: z.string().trim().optional(), // e.g. "Black,Navy"
  minPrice: z.coerce.number().int().min(0).optional(), // rupees
  maxPrice: z.coerce.number().int().min(0).optional(), // rupees
  sort: z.enum(productSortValues).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  /** Emoji/glyph for the category nav bar and mega menu. */
  icon: string | null;
  children: CategoryNode[];
}

export interface ProductListItem {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  categoryName: string;
  /** Lowest variant price / MRP, in paise. */
  pricePaise: number;
  mrpPaise: number | null;
  imageUrl: string | null;
  sizes: string[];
  colors: string[];
  ratingAvg: number | null;
  ratingCount: number;
}

export interface ProductListResponse {
  items: ProductListItem[];
  total: number;
  page: number;
  limit: number;
  /** Available filter values within the current category scope. */
  facets: {
    sizes: string[];
    colors: string[];
    /** Price bounds (paise) across the scope — drives the range slider. */
    priceRange: { minPaise: number; maxPaise: number } | null;
  };
}

export interface ProductVariantInfo {
  id: string;
  size: string;
  color: string;
  sku: string;
  pricePaise: number;
  mrpPaise: number | null;
  stock: number;
}

export interface ProductDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  brand: string | null;
  category: { name: string; slug: string };
  /**
   * Slug of the top-level category (e.g. "fashion" for men-t-shirts).
   * The PDP uses it to offer AI Try-On only on wearable categories now that
   * the catalogue also has electronics above the try-on price floor.
   */
  rootCategorySlug: string;
  sellerShopName: string;
  images: { url: string; altText: string | null }[];
  variants: ProductVariantInfo[];
  ratingAvg: number | null;
  ratingCount: number;
  createdAt: string;
}

export interface WishlistEntry {
  productId: string;
  addedAt: string;
  product: ProductListItem;
}
