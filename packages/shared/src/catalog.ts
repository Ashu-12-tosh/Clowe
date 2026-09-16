import { z } from 'zod';
import type { ParsedSearchQuery } from './searchQuery';
import type { CategoryRules } from './categoryRules';
import type { VariantAxis } from './variants';

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
  /** Generic option filters, e.g. opt[ram]=16GB&opt[color]=Black. */
  opt: z.record(z.string().trim().max(60)).optional(),
  minPrice: z.coerce.number().int().min(0).optional(), // rupees
  maxPrice: z.coerce.number().int().min(0).optional(), // rupees
  sort: z.enum(productSortValues).default('newest'),
  /**
   * Filters parsed out of `q` that the shopper has dismissed, comma separated.
   *
   * Removing a chip must not turn the rest of the query into explicit filters.
   * The parser infers a category from words like "phone", and that inference
   * is only ever allowed to rank — this catalog files smartphones under two
   * parents, so promoting the guess to a filter would hide half of them. So
   * `q` is sent back unchanged and the dismissed keys are named here, letting
   * the server re-parse and then drop exactly what was dismissed.
   */
  drop: z.string().trim().optional(),
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
  /** Resolved marketplace rules (own -> parent -> platform default). */
  rules: CategoryRules;
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
    /** Every option axis in scope with its values; sizes/colors above are the size/color axes. */
    options: { key: string; label: string; values: string[] }[];
    /** Brands in scope with how many products each has. */
    brands: FacetCount[];
    /** Subcategories in scope with their product counts. */
    categories: (FacetCount & { slug: string })[];
    /** Price bounds (paise) across the scope — drives the range slider. */
    priceRange: { minPaise: number; maxPaise: number } | null;
    /** Rating buckets ("4★ & up") with counts. Only built for search requests. */
    ratings?: RatingFacet[];
    /** Price buckets for the "under ₹X" shortcuts. Only built for search requests. */
    priceBuckets?: PriceBucketFacet[];
  };
  /** Present only when `q` was given — how the query was understood and matched. */
  search?: SearchMeta;
}

/** "4★ & up" and how many products clear it. */
export interface RatingFacet {
  /** Inclusive lower bound, 1-5. */
  minRating: number;
  count: number;
}

/** A price shortcut such as "Under ₹15,000". Bounds are paise. */
export interface PriceBucketFacet {
  label: string;
  minPaise: number | null;
  maxPaise: number | null;
  count: number;
}

/** A filter the search dropped to avoid returning nothing. */
export const searchRelaxableValues = ['minPrice', 'maxPrice', 'brands', 'onSale', 'keywords'] as const;

/** Parsed filters a shopper can dismiss from the results page. */
export const searchDroppableValues = [
  'minPrice',
  'maxPrice',
  'brands',
  'onSale',
  'category',
  'sort',
] as const;
export type SearchDroppable = (typeof searchDroppableValues)[number];
export type SearchRelaxable = (typeof searchRelaxableValues)[number];

export interface SearchRelaxation {
  /** Dropped in the order listed, least important first. */
  dropped: SearchRelaxable[];
  /** Ready to show: "No exact matches — showing phones under ₹18,000 instead." */
  message: string;
}

/**
 * How a search request was understood and answered.
 *
 * Exists so the UI never has to guess: it can render the parsed filters as
 * removable chips, say why a result from another category appeared, and admit
 * when it had to loosen the query rather than quietly showing something else.
 */
export interface SearchMeta {
  /** Raw string as typed. */
  raw: string;
  /** What the parser pulled out — drives the filter chips. */
  parsed: ParsedSearchQuery;
  /** How the rows were found. 'trigram' means the text was matched fuzzily. */
  strategy: 'fts' | 'trigram' | 'filters-only' | 'none';
  /** Set when filters had to be loosened; null when the query matched as asked. */
  relaxed: SearchRelaxation | null;
  /**
   * How many returned products sit outside the category the parser guessed.
   *
   * The guess only ranks, never filters, so results from elsewhere are
   * expected and correct — this is what lets the UI explain one instead of
   * looking broken.
   */
  outsideInferredCategory: number;
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
  /** The option combination this variant is, e.g. { ram: "16GB", storage: "512GB" }. */
  optionValues: Record<string, string>;
  /** Human label ("Black · L"); "" for a single-SKU product. */
  label: string;
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
  /** Option axes in display order - drives the selectors on the product page. */
  variantAxes: VariantAxis[];
  /** Category allows AI Try-On and the seller has it on (price floor is checked separately). */
  tryOnEligible: boolean;
  /** Show the size guide (wearable categories with a size axis). */
  sizeGuide: boolean;
  /** Days after delivery a return can be requested. */
  returnWindowDays: number;
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
  /** Category allows AI Try-On and the seller has it on. */
  tryOnEligible: boolean;
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
