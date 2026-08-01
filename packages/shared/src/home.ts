import { z } from 'zod';

// ---------------------------------------------------------------------------
// Landing page (GET /api/home) — one aggregated, server-cached payload
// ---------------------------------------------------------------------------

/** Compact product card used by the landing sections (deals / trending). */
export interface HomeProductCard {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  pricePaise: number;
  mrpPaise: number | null;
  /** Rounded % off, null when no MRP above price. */
  discountPercent: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  /** First in-stock variant — enables the quick add-to-cart icon. */
  defaultVariantId: string | null;
  badge: 'BEST_SELLER' | 'NEW' | 'TRENDING' | null;
}

export interface HomeBannerView {
  id: string;
  headline: string;
  highlight: string | null;
  subtext: string | null;
  imageUrl: string | null;
  primaryLabel: string;
  primaryHref: string;
  secondaryLabel: string | null;
  secondaryHref: string | null;
}

export interface PromoTileView {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  href: string;
}

export interface HomeCategoryTile {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  imageUrl: string | null;
}

export interface HomeBrandTile {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

export interface HomeDealView {
  id: string;
  title: string;
  /** ISO instant the countdown targets. */
  endsAt: string;
  products: HomeProductCard[];
}

export interface HomePayload {
  banners: HomeBannerView[];
  promoCards: PromoTileView[];
  /** Active deal window, or null → section hidden. */
  deal: HomeDealView | null;
  categories: HomeCategoryTile[];
  trending: HomeProductCard[];
  promoStrips: PromoTileView[];
  brands: HomeBrandTile[];
}

// ---------------------------------------------------------------------------
// Newsletter
// ---------------------------------------------------------------------------

export const newsletterSubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(120),
});
export type NewsletterSubscribeInput = z.infer<typeof newsletterSubscribeSchema>;

export interface NewsletterSubscriberRow {
  id: string;
  email: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Header badge counts (cart / wishlist / notifications)
// ---------------------------------------------------------------------------

export interface MyCounts {
  cart: number;
  wishlist: number;
  notifications: number;
}

// ---------------------------------------------------------------------------
// Admin: brands
// ---------------------------------------------------------------------------

export const brandUpsertSchema = z.object({
  name: z.string().trim().min(2).max(40),
  logoUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
export type BrandUpsertInput = z.infer<typeof brandUpsertSchema>;

export interface AdminBrandRow {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
}

// ---------------------------------------------------------------------------
// Admin: hero banners
// ---------------------------------------------------------------------------

export const bannerUpsertSchema = z.object({
  headline: z.string().trim().min(3).max(80),
  highlight: z.string().trim().max(40).nullable().optional(),
  subtext: z.string().trim().max(200).nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  primaryLabel: z.string().trim().min(1).max(30).optional(),
  primaryHref: z.string().trim().min(1).max(200).optional(),
  secondaryLabel: z.string().trim().max(30).nullable().optional(),
  secondaryHref: z.string().trim().max(200).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
export type BannerUpsertInput = z.infer<typeof bannerUpsertSchema>;

export interface AdminBannerRow extends HomeBannerView {
  sortOrder: number;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Admin: promo tiles
// ---------------------------------------------------------------------------

export const promoPlacementValues = ['PROMO_CARD', 'PROMO_STRIP'] as const;
export type PromoPlacementValue = (typeof promoPlacementValues)[number];

export const promoTileUpsertSchema = z.object({
  placement: z.enum(promoPlacementValues),
  title: z.string().trim().min(2).max(60),
  subtitle: z.string().trim().max(80).nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  href: z.string().trim().min(1).max(200).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
export type PromoTileUpsertInput = z.infer<typeof promoTileUpsertSchema>;

export interface AdminPromoTileRow extends PromoTileView {
  placement: PromoPlacementValue;
  sortOrder: number;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Admin: deals of the day
// ---------------------------------------------------------------------------

export const dealUpsertSchema = z.object({
  title: z.string().trim().min(2).max(60).optional(),
  /** ISO datetimes. */
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  isActive: z.boolean().optional(),
  productIds: z.array(z.string()).min(1, 'Pick at least one product').max(24),
});
export type DealUpsertInput = z.infer<typeof dealUpsertSchema>;

export interface AdminDealRow {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  isActive: boolean;
  /** LIVE = window contains now; UPCOMING = starts later; ENDED = over. */
  state: 'LIVE' | 'UPCOMING' | 'ENDED';
  products: { id: string; title: string; imageUrl: string | null }[];
}
