import { imageUrlSchema } from './imageUrl';
import { linkHrefSchema } from './url';
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

// ---------------------------------------------------------------------------
// Banner images: designed (our text beside or over a picture) or full image
// ---------------------------------------------------------------------------

export const BANNER_IMAGE_MODES = ['DESIGNED', 'FULL_IMAGE'] as const;
export type BannerImageModeValue = (typeof BANNER_IMAGE_MODES)[number];

/** The image fields every banner and promo tile shares. */
const bannerImageFields = {
  imageMode: z.enum(BANNER_IMAGE_MODES).optional(),
  /** What the image says, for screen readers; required for a full-image banner. */
  altText: z.string().trim().max(200).nullable().optional(),
  /** Shown instead of imageUrl on phones; null: imageUrl everywhere. */
  mobileImageUrl: imageUrlSchema.nullable().optional(),
  /** The point that must stay in view when the picture is cropped, in percent. */
  focalX: z.number().int().min(0).max(100).optional(),
  focalY: z.number().int().min(0).max(100).optional(),
};

/** CSS object-position for a focal point (50/50, the centre, when unset). */
export function focalPosition(p: { focalX?: number | null; focalY?: number | null }): string {
  return `${p.focalX ?? 50}% ${p.focalY ?? 50}%`;
}

/**
 * Why a banner can't be saved as it stands, if it can't: a full-image banner
 * is nothing but its image, so it needs one, and alt text saying what it says.
 * Checked on the finished banner (after a partial edit too), here and in the API.
 */
export function bannerImageProblem(b: {
  imageMode?: BannerImageModeValue | null;
  imageUrl?: string | null;
  altText?: string | null;
}): { field: 'imageUrl' | 'altText'; message: string } | null {
  if (b.imageMode !== 'FULL_IMAGE') return null;
  if (!b.imageUrl?.trim()) return { field: 'imageUrl', message: 'A full-image banner needs its image' };
  if ((b.altText?.trim().length ?? 0) < 5) {
    return { field: 'altText', message: 'Describe the image for screen readers (at least 5 characters)' };
  }
  return null;
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
  imageMode: BannerImageModeValue;
  altText: string | null;
  /** On phones instead of imageUrl, when set. */
  mobileImageUrl: string | null;
  focalX: number;
  focalY: number;
}

export interface PromoTileView {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  href: string;
  imageMode: BannerImageModeValue;
  altText: string | null;
  mobileImageUrl: string | null;
  focalX: number;
  focalY: number;
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
  logoUrl: imageUrlSchema.nullable().optional(),
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
  imageUrl: imageUrlSchema.nullable().optional(),
  primaryLabel: z.string().trim().min(1).max(30).optional(),
  primaryHref: linkHrefSchema(200).optional(),
  secondaryLabel: z.string().trim().max(30).nullable().optional(),
  secondaryHref: linkHrefSchema(200).or(z.literal('')).nullable().optional(),
  ...bannerImageFields,
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
  imageUrl: imageUrlSchema.nullable().optional(),
  href: linkHrefSchema(200).optional(),
  ...bannerImageFields,
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
// Admin: category banners (the carousel on a category's landing page)
// ---------------------------------------------------------------------------

export const categoryBannerUpsertSchema = z.object({
  categoryId: z.string().min(1),
  eyebrow: z.string().trim().max(40).nullable().optional(),
  headline: z.string().trim().min(3).max(80),
  highlight: z.string().trim().max(40).nullable().optional(),
  subtext: z.string().trim().max(200).nullable().optional(),
  imageUrl: imageUrlSchema.nullable().optional(),
  primaryLabel: z.string().trim().min(1).max(30).optional(),
  primaryHref: linkHrefSchema(200).or(z.literal('')).nullable().optional(),
  ...bannerImageFields,
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
export type CategoryBannerUpsertInput = z.infer<typeof categoryBannerUpsertSchema>;

export interface AdminCategoryBannerRow {
  id: string;
  categoryId: string;
  categoryName: string;
  eyebrow: string | null;
  headline: string;
  highlight: string | null;
  subtext: string | null;
  imageUrl: string | null;
  primaryLabel: string;
  primaryHref: string | null;
  imageMode: BannerImageModeValue;
  altText: string | null;
  mobileImageUrl: string | null;
  focalX: number;
  focalY: number;
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
