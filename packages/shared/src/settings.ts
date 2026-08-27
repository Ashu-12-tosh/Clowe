import { z } from 'zod';
import type { ProductListItem } from './catalog';

// ---------------------------------------------------------------------------
// Platform settings (admin-editable; defaults live in the API)
// ---------------------------------------------------------------------------

export const AD_PLACEMENTS = ['HOME_BANNER', 'CATEGORY_SPONSORED'] as const;
export type AdPlacementValue = (typeof AD_PLACEMENTS)[number];

export const AD_PLACEMENT_LABELS: Record<AdPlacementValue, string> = {
  HOME_BANNER: 'Home page banner',
  CATEGORY_SPONSORED: 'Sponsored slot in category listing',
};

export const AD_DURATIONS = [7, 15, 30] as const;

/** Price per placement per duration, in paise. Keys are '7' | '15' | '30'. */
export type AdPricing = Record<AdPlacementValue, Record<'7' | '15' | '30', number>>;

/**
 * An offer listed on the product page. These are informational (a bank offer
 * is applied by the bank, not by Clowe) — store discounts run through coupons.
 */
export interface PdpOffer {
  label: string;
  text: string;
  terms: string | null;
}

export interface PlatformSettings {
  /** Minimum product price (paise) for AI Try-On. */
  tryonMinPricePaise: number;
  /** Master switch for AI Try-On — false stops all new runs. */
  tryonEnabled: boolean;
  /** Successful/pending runs allowed per shopper per day. */
  tryonDailyLimit: number;
  /** Provider spend cap for the current month (paise); 0 = unlimited. */
  tryonMonthlyBudgetPaise: number;
  /** Marketplace commission withheld from a seller's sales, in percent. */
  payoutCommissionPercent: number;
  /** Payment-gateway charge withheld, in percent of the line total. */
  payoutGatewayPercent: number;
  /** Section 194-O TDS withheld on gross sales, in percent. */
  payoutTdsPercent: number;
  /** Smallest payout a seller may request (paise). */
  payoutMinPaise: number;
  /** Days after delivery before earnings clear (covers the return window). */
  payoutHoldDays: number;
  /** Platform-wide return window; a seller may set a longer one of their own. */
  returnWindowDays: number;
  /** How long audit entries are kept before they can be purged. */
  auditRetentionDays: number;
  /** Social links shown in the footer; empty string = "coming soon". */
  socialLinks: { facebook: string; twitter: string; instagram: string };
  adPricing: AdPricing;
  /** Bank/EMI offers shown on every product page. */
  pdpOffers: PdpOffer[];
}

/** Subset that anonymous visitors may read. */
export interface PublicSettings {
  tryonMinPricePaise: number;
  socialLinks: PlatformSettings['socialLinks'];
  pdpOffers: PdpOffer[];
}

const adPriceRow = z.object({
  '7': z.number().int().min(0),
  '15': z.number().int().min(0),
  '30': z.number().int().min(0),
});

/** PUT /api/admin/settings — partial update. */
export const updateSettingsSchema = z.object({
  tryonMinPricePaise: z.number().int().min(0).optional(),
  payoutCommissionPercent: z.number().min(0).max(50).optional(),
  payoutGatewayPercent: z.number().min(0).max(20).optional(),
  payoutTdsPercent: z.number().min(0).max(20).optional(),
  payoutMinPaise: z.number().int().min(0).optional(),
  payoutHoldDays: z.number().int().min(0).max(90).optional(),
  socialLinks: z
    .object({
      facebook: z.string().trim().url().or(z.literal('')),
      twitter: z.string().trim().url().or(z.literal('')),
      instagram: z.string().trim().url().or(z.literal('')),
    })
    .optional(),
  adPricing: z.object({ HOME_BANNER: adPriceRow, CATEGORY_SPONSORED: adPriceRow }).optional(),
  pdpOffers: z
    .array(
      z.object({
        label: z.string().trim().min(2).max(40),
        text: z.string().trim().min(4).max(160),
        terms: z.string().trim().max(300).nullable(),
      }),
    )
    .max(10)
    .optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// ---------------------------------------------------------------------------
// Seller ads
// ---------------------------------------------------------------------------

export const adCreateSchema = z.object({
  productId: z.string().min(1),
  placement: z.enum(AD_PLACEMENTS),
  durationDays: z.union([z.literal(7), z.literal(15), z.literal(30)]),
});
export type AdCreateInput = z.infer<typeof adCreateSchema>;

export const adDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim().min(5, 'Give the seller a reason (min 5 chars)').max(300),
  }),
]);
export type AdDecisionInput = z.infer<typeof adDecisionSchema>;

export interface SellerAdRow {
  id: string;
  productId: string;
  productTitle: string;
  productSlug: string;
  imageUrl: string | null;
  placement: AdPlacementValue;
  durationDays: number;
  pricePaise: number;
  status: string; // PENDING | ACTIVE | REJECTED | EXPIRED
  rejectionReason: string | null;
  startAt: string | null;
  endAt: string | null;
  views: number;
  clicks: number;
  createdAt: string;
}

export interface AdminAdRow extends SellerAdRow {
  shopName: string;
}

/**
 * Public shape served to the storefront ad slots. The product is a full
 * listing item so sponsored cards render exactly like organic ones —
 * only a small "Sponsored" label sets them apart.
 */
export interface ActiveAd {
  id: string; // ad id (click tracking)
  placement: AdPlacementValue;
  product: ProductListItem;
}

// ---------------------------------------------------------------------------
// Seller-to-seller referrals
// ---------------------------------------------------------------------------

export const sellerReferralCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^SLR-[A-Z0-9]{6}$/, 'Referral code looks like SLR-XXXXXX');

export interface SellerReferralInfo {
  code: string;
  targetPaise: number; // referred seller's delivered sales needed
  rewardPaise: number; // what the referrer earns
  creditsEarnedPaise: number; // total earned so far
  referrals: {
    id: string;
    shopName: string;
    joinedAt: string;
    sellerApproved: boolean;
    salesPaise: number;
    status: string; // PENDING | EARNED | VOID
    earnedAt: string | null;
  }[];
}

export interface AdminSellerReferralRow {
  id: string;
  referrerShop: string;
  referredShop: string;
  referredApproved: boolean;
  salesPaise: number;
  targetPaise: number;
  status: string;
  rewardPaise: number;
  earnedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

export const voidReferralSchema = z.object({
  reason: z.string().trim().min(5, 'Reason required (min 5 chars)').max(300),
});
