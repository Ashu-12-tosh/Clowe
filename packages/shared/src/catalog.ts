import { z } from 'zod';

// ---------------------------------------------------------------------------
// Product listing query (shared by API validation and web client)
// ---------------------------------------------------------------------------

// No "discount" sort: there is no stored discount column, and ordering by MRP
// as a stand-in ranks expensive products rather than the deepest cuts.
export const productSortValues = [
  'popularity',
  'newest',
  'price_asc',
  'price_desc',
  'rating',
] as const;
export type ProductSort = (typeof productSortValues)[number];

export const PRODUCT_SORT_LABELS: Record<ProductSort, string> = {
  popularity: 'Popularity',
  newest: 'Newest First',
  price_asc: 'Price: Low to High',
  price_desc: 'Price: High to Low',
  rating: 'Customer Rating',
};

/** Query params for GET /api/products. Comma-separated lists for sizes/colors. */
export const productListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().optional(), // category slug (includes children)
  sizes: z.string().trim().optional(), // e.g. "S,M,L"
  colors: z.string().trim().optional(), // e.g. "Black,Navy"
  brands: z.string().trim().optional(), // e.g. "NovaTech,Aeris"
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

/** One slide of a category's hero carousel. */
export interface CategoryBannerSlide {
  id: string;
  eyebrow: string | null;
  headline: string;
  /** Accented tail of the headline, rendered in the brand colour. */
  highlight: string | null;
  subtext: string | null;
  imageUrl: string | null;
  primaryLabel: string;
  primaryHref: string | null;
}

/** An icon + two lines, used by the hero side card and the feature strip. */
export interface CategoryCallout {
  icon: string;
  title: string;
  subtitle: string;
}

/** A category landing page: hero carousel, blurb and its subcategory tiles. */
export interface CategoryDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** Subcategory tile shape on the rail. */
  tileShape: 'square' | 'circle';
  banners: CategoryBannerSlide[];
  /** Hero side-card bullets (empty when the category has none). */
  highlights: CategoryCallout[];
  /** Bottom feature strip. */
  features: CategoryCallout[];
  /** Direct children, each with its tile image and live product count. */
  children: {
    id: string;
    name: string;
    slug: string;
    imageUrl: string | null;
    productCount: number;
  }[];
  /** Live products in this category and everything under it. */
  productCount: number;
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
  /**
   * Cheapest in-stock variant — lets a listing card add straight to the cart
   * without a trip to the product page. Null when everything is out of stock.
   */
  defaultVariantId: string | null;
  inStock: boolean;
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
    /** Brands in scope with how many products each has. */
    brands: FacetCount[];
    /** Subcategories in scope with their product counts. */
    categories: (FacetCount & { slug: string })[];
    /** Price bounds (paise) across the scope — drives the range slider. */
    priceRange: { minPaise: number; maxPaise: number } | null;
  };
}

export interface FacetCount {
  name: string;
  count: number;
}

/**
 * A low-cost add-on for the checkout's "Frequently bought together" row.
 * Carries a ready-to-add variant so one tap puts it in the cart.
 */
export interface AddonProduct {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  pricePaise: number;
  mrpPaise: number | null;
  variantId: string;
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
  /** Who fulfils the order — shown in the "Sold by" card. */
  seller: {
    shopName: string;
    city: string | null;
    state: string | null;
    /** Admin-approved store. */
    isVerified: boolean;
    /** Store URL slug, when the seller has claimed one. */
    slug: string | null;
  };
  images: { url: string; altText: string | null }[];
  variants: ProductVariantInfo[];
  ratingAvg: number | null;
  ratingCount: number;
  /** Units sold — powers the "12K+ Sold" line. */
  soldCount: number;
  isBestSeller: boolean;
  isNew: boolean;
  /** Key-feature bullets (empty when the seller hasn't added any). */
  highlights: string[];
  /** One-line pitch from the listing form; null when not filled in. */
  shortDescription: string | null;
  /** Spec sheet the seller filled in: [{ name, value }]. */
  attributes: { name: string; value: string }[];
  /** Optional YouTube/Vimeo link the seller added. */
  videoUrl: string | null;
  createdAt: string;
}

export interface WishlistEntry {
  productId: string;
  addedAt: string;
  product: ProductListItem;
  /** Top-level category, for the filter chips and Try-On eligibility. */
  rootCategorySlug: string;
  rootCategoryName: string;
  isBestSeller: boolean;
  isNew: boolean;
  /** Cheapest price when saved — a lower price today is a price drop. */
  priceAtAddPaise: number | null;
}

/** A wishlist someone shared by link (public, read-only). */
export interface SharedWishlist {
  ownerName: string;
  items: WishlistEntry[];
}

/** Result of sharing/revoking a wishlist link. */
export interface WishlistShare {
  /** Path to the public wishlist page; null once sharing is revoked. */
  path: string | null;
}

/** Serviceability + speeds for a pincode (GET /api/delivery/options). */
export interface DeliveryQuote {
  pincode: string | null;
  serviceable: boolean;
  /** Why the pincode was rejected, when serviceable is false. */
  message: string | null;
  options: import('./checkout').DeliveryOption[];
}
