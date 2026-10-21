import { z } from 'zod';
import type { ReferralFeeSlab } from './referralFees';

// ---------------------------------------------------------------------------
// Clowe's commercial rules (owner's Batch 2): what sellers pay Clowe — per
// order line, per month for a plan, for advertising and sponsorship, and for
// AI Try-On credits. Every number lives here, in ONE admin-editable setting
// ("commercial"), validated by this schema; the code reads it, never a
// literal. Every Clowe charge is exclusive of GST: GST at fees.gstPercent is
// added on top and shown on Clowe's monthly tax invoice to the seller.
// Statutory TDS (s.194-O) and GST TCS (s.52) are not Clowe charges and stay
// in their own settings.
// ---------------------------------------------------------------------------

const paise = z.number().int().min(0);
const percent = z.number().min(0).max(100);
const range = z.tuple([paise, paise]).refine(([lo, hi]) => lo <= hi, 'The minimum must not exceed the maximum');

// --- 1. Fees per order line --------------------------------------------------

/** A handling-fee slab: from this unit selling price (GST included) up, this fee per unit. */
export const handlingSlabSchema = z.object({ fromPaise: paise, feePaise: paise });
export type HandlingSlab = z.infer<typeof handlingSlabSchema>;

// --- 2. Plans ------------------------------------------------------------------

export const SELLER_PLANS = ['FREE', 'GROWTH', 'PRO', 'PREMIUM'] as const;
export type SellerPlan = (typeof SELLER_PLANS)[number];

/** What a plan unlocks; checked wherever the feature is used. */
export const PLAN_FEATURES = [
  'AI_LISTING',
  'AI_SEARCH_VISIBILITY',
  'BETTER_ANALYTICS',
  'PROMOTION_TOOLS',
  'SPIN_360',
  'ADVANCED_ANALYTICS',
  'PRIORITY_SUPPORT',
  'RANKING_BOOST',
  'AI_MARKETING',
  'FEATURED_PLACEMENT',
  'DEDICATED_SUPPORT',
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/**
 * Plan features whose part of the site is not built yet (AI search and AI
 * compare): shown as "Coming soon", never promised as working.
 */
export const PLAN_FEATURES_COMING_SOON: readonly PlanFeature[] = [];

export const PLAN_FEATURE_LABELS: Record<PlanFeature, string> = {
  AI_LISTING: 'AI listing generation',
  AI_SEARCH_VISIBILITY: 'Products in AI search and compare',
  BETTER_ANALYTICS: 'Better analytics',
  PROMOTION_TOOLS: 'Promotion tools',
  SPIN_360: '360° product view',
  ADVANCED_ANALYTICS: 'Advanced analytics',
  PRIORITY_SUPPORT: 'Priority seller support',
  RANKING_BOOST: 'Higher visibility (Featured, labelled)',
  AI_MARKETING: 'AI marketing assistance',
  FEATURED_PLACEMENT: 'Featured placement',
  DEDICATED_SUPPORT: 'Dedicated seller support',
};

const planSchema = z.object({
  pricePaise: paise,
  /** null: unlimited live products. */
  maxLiveProducts: z.number().int().min(1).nullable(),
  /** Advertising credit added each month the plan renews. */
  monthlyAdCreditPaise: paise,
  /** The handling fee is waived on this plan. */
  waivesHandlingFee: z.boolean(),
  features: z.array(z.enum(PLAN_FEATURES)),
});
export type PlanRules = z.infer<typeof planSchema>;

// --- 3. Advertising --------------------------------------------------------------

/** Pay-per-click ad types; each serves in its own labelled slot. */
export const CPC_AD_TYPES = [
  'SPONSORED_PRODUCT',
  'AI_SEARCH_BOOST',
  'AI_RECOMMENDATION_BOOST',
  'TOP_SEARCH',
  'CATEGORY_PROMOTION',
  'SPIN360_PROMOTION',
  'TRYON_PROMOTION',
  'COMPARE_PROMOTION',
] as const;
export type CpcAdType = (typeof CPC_AD_TYPES)[number];

export const CPC_AD_TYPE_LABELS: Record<CpcAdType, string> = {
  SPONSORED_PRODUCT: 'Sponsored Product',
  AI_SEARCH_BOOST: 'AI Search Boost',
  AI_RECOMMENDATION_BOOST: 'AI Recommendation Boost',
  TOP_SEARCH: 'Top Search Placement',
  CATEGORY_PROMOTION: 'Category Page Promotion',
  SPIN360_PROMOTION: '360° Product Promotion',
  TRYON_PROMOTION: 'AI Try-On Promotion',
  COMPARE_PROMOTION: 'AI Compare Promotion',
};

/** Fixed-price campaigns. */
export const AD_PACKAGES = ['STARTER', 'GROWTH', 'PREMIUM', 'LUXURY', 'ENTERPRISE'] as const;
export type AdPackage = (typeof AD_PACKAGES)[number];

/** Slots booked by the day or by the campaign, on a calendar with no double booking. */
export const PLACEMENT_KINDS = [
  'HOMEPAGE_BANNER',
  'CATEGORY_BANNER',
  'FEATURED_SELLER',
  'FLASH_SALE',
  'NEW_COLLECTION',
  // Sponsorship (its own rate card, the same calendar)
  'SP_BASIC_PRODUCT',
  'SP_CATEGORY_TOP',
  'SP_HOMEPAGE_FEATURED',
  'SP_HOMEPAGE_BANNER',
  'SP_BRAND_SPOTLIGHT',
  'SP_FESTIVAL_CAMPAIGN',
] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

/**
 * The space on the site a placement occupies. Advertising and sponsorship
 * selling the same space share its slots, so they can never clash.
 */
export const PLACEMENT_SPACE: Record<PlacementKind, string> = {
  HOMEPAGE_BANNER: 'HOMEPAGE_BANNER',
  SP_HOMEPAGE_BANNER: 'HOMEPAGE_BANNER',
  CATEGORY_BANNER: 'CATEGORY_BANNER',
  SP_CATEGORY_TOP: 'CATEGORY_TOP',
  FEATURED_SELLER: 'FEATURED_SELLER',
  FLASH_SALE: 'FLASH_SALE',
  NEW_COLLECTION: 'NEW_COLLECTION',
  SP_BASIC_PRODUCT: 'BASIC_PRODUCT',
  SP_HOMEPAGE_FEATURED: 'HOMEPAGE_FEATURED',
  SP_BRAND_SPOTLIGHT: 'BRAND_SPOTLIGHT',
  SP_FESTIVAL_CAMPAIGN: 'FESTIVAL_CAMPAIGN',
};

export const PLACEMENT_LABELS: Record<PlacementKind, string> = {
  HOMEPAGE_BANNER: 'Homepage Banner',
  CATEGORY_BANNER: 'Category Banner',
  FEATURED_SELLER: 'Featured Seller',
  FLASH_SALE: 'Flash Sale Promotion',
  NEW_COLLECTION: 'New Collection Spotlight',
  SP_BASIC_PRODUCT: 'Basic Product Promotion',
  SP_CATEGORY_TOP: 'Category Top Placement',
  SP_HOMEPAGE_FEATURED: 'Homepage Featured Product',
  SP_HOMEPAGE_BANNER: 'Homepage Banner',
  SP_BRAND_SPOTLIGHT: 'Brand Spotlight',
  SP_FESTIVAL_CAMPAIGN: 'Festival Campaign',
};

/** DAY: priced per day booked; CAMPAIGN: per campaign of campaignDays; WEEK: per 7 days. */
export const PLACEMENT_UNITS = ['DAY', 'CAMPAIGN', 'WEEK'] as const;

const placementSchema = z.object({
  /** The range the price must stay inside (the owner's rate card). */
  rangePaise: range,
  /** What it costs now — set by admin inside the range. */
  pricePaise: paise,
  unit: z.enum(PLACEMENT_UNITS),
  /** How many sellers can hold the space at once. */
  slots: z.number().int().min(1).max(50),
  /** Needs a banner or creative, approved before going live. */
  needsCreative: z.boolean(),
  /** Sponsorship (true) or advertising (false). */
  sponsorship: z.boolean(),
});
export type PlacementRules = z.infer<typeof placementSchema>;

// --- The whole setting ---------------------------------------------------------------

export const commercialSettingsSchema = z.object({
  fees: z.object({
    /** Default referral fee, percent of the selling price; each category has its own (Admin → Categories). */
    referralPercent: percent,
    gtPercent: percent,
    collectionPercent: percent,
    handlingSlabs: z.array(handlingSlabSchema).min(1),
    /** GST on every Clowe charge. */
    gstPercent: percent,
  }),
  penalties: z.object({
    counterfeitListingPaise: paise,
    inaccurateTryOnDataPaise: paise,
  }),
  plans: z.object({
    FREE: planSchema,
    GROWTH: planSchema,
    PRO: planSchema,
    PREMIUM: planSchema,
    /** Days to pay a renewal before a downgrade to FREE. */
    graceDays: z.number().int().min(0).max(30),
    /** Days existing sellers over the FREE product limit keep everything live. */
    existingSellerLimitGraceDays: z.number().int().min(0).max(365),
  }),
  ads: z.object({
    cpcRanges: z.record(z.enum(CPC_AD_TYPES), range),
    /** Ad types not sold yet (the surface does not exist on the site). */
    unavailableTypes: z.array(z.enum(CPC_AD_TYPES)),
    campaignDays: z.number().int().min(1).max(90),
    packages: z.record(z.enum(AD_PACKAGES), z.object({ pricePaise: paise, types: z.array(z.enum(CPC_AD_TYPES)), placements: z.array(z.enum(PLACEMENT_KINDS)) })),
    placements: z.record(z.enum(PLACEMENT_KINDS), placementSchema),
    welcomeCreditPaise: paise,
    attributionDays: z.number().int().min(1).max(60),
  }),
  sponsorship: z.object({
    /** Sponsored-product sponsorship is per click, inside this range. */
    perClickRangePaise: range,
    /** What Premium sellers save on sponsorship, percent (100 = free). */
    premiumDiscountPercent: percent,
  }),
  /** Clowe's monthly tax invoice to sellers. */
  invoice: z.object({
    /** SAC for Clowe's services to sellers — confirm with the CA. */
    sacCode: z.string().trim().min(4).max(8),
    numberPrefix: z.string().trim().min(1).max(12),
  }),
  tryon: z.object({
    packs: z.array(z.object({ credits: z.number().int().min(1), pricePaise: paise })).min(1),
    /** Above the biggest pack: per credit, added by admin after a support request. */
    extraCreditPaise: paise,
    /** Credits expire after this many days; null = never. */
    expiryDays: z.number().int().min(1).nullable(),
    freeGrantCredits: z.number().int().min(0),
    freeGrantSellers: z.number().int().min(0),
    /** Admin only: what one credit costs Clowe now, and at later volume tiers. */
    costPerCreditPaise: paise,
    tierCostsPaise: z.array(paise),
    phaseNote: z.string().max(300),
  }),
});
export type CommercialSettings = z.infer<typeof commercialSettingsSchema>;

const ALL_FEATURES: PlanFeature[] = [...PLAN_FEATURES];

export const DEFAULT_COMMERCIAL: CommercialSettings = {
  fees: {
    referralPercent: 2,
    gtPercent: 1.5,
    collectionPercent: 2,
    handlingSlabs: [
      { fromPaise: 0, feePaise: 900 },
      { fromPaise: 50_000, feePaise: 1_400 },
      { fromPaise: 100_000, feePaise: 1_900 },
      { fromPaise: 500_000, feePaise: 2_500 },
      { fromPaise: 2_000_000, feePaise: 4_000 },
    ],
    gstPercent: 18,
  },
  penalties: { counterfeitListingPaise: 15_000, inaccurateTryOnDataPaise: 100_000 },
  plans: {
    FREE: { pricePaise: 0, maxLiveProducts: 15, monthlyAdCreditPaise: 0, waivesHandlingFee: false, features: [] },
    GROWTH: {
      pricePaise: 59_900,
      maxLiveProducts: 100,
      monthlyAdCreditPaise: 0,
      waivesHandlingFee: false,
     
      features: ['AI_LISTING', 'AI_SEARCH_VISIBILITY', 'BETTER_ANALYTICS', 'PROMOTION_TOOLS'],
    },
    PRO: {
      pricePaise: 99_900,
      maxLiveProducts: null,
      monthlyAdCreditPaise: 50_000,
      waivesHandlingFee: false,
     
      features: ['AI_LISTING', 'AI_SEARCH_VISIBILITY', 'BETTER_ANALYTICS', 'PROMOTION_TOOLS', 'SPIN_360', 'ADVANCED_ANALYTICS', 'PRIORITY_SUPPORT'],
    },
    PREMIUM: {
      pricePaise: 199_900,
      maxLiveProducts: null,
      monthlyAdCreditPaise: 100_000,
      waivesHandlingFee: true,
     
      features: ALL_FEATURES,
    },
    graceDays: 3,
    existingSellerLimitGraceDays: 30,
  },
  ads: {
    cpcRanges: {
      SPONSORED_PRODUCT: [300, 1_200],
      AI_SEARCH_BOOST: [300, 1_000],
      AI_RECOMMENDATION_BOOST: [300, 800],
      TOP_SEARCH: [700, 2_000],
      CATEGORY_PROMOTION: [300, 1_000],
      SPIN360_PROMOTION: [500, 1_500],
      TRYON_PROMOTION: [300, 1_000],
      COMPARE_PROMOTION: [300, 1_000],
    },
    unavailableTypes: [],
    campaignDays: 7,
    packages: {
      STARTER: { pricePaise: 49_900, types: ['SPONSORED_PRODUCT', 'AI_SEARCH_BOOST'], placements: [] },
      GROWTH: { pricePaise: 99_900, types: ['SPONSORED_PRODUCT', 'AI_SEARCH_BOOST', 'CATEGORY_PROMOTION'], placements: [] },
      PREMIUM: { pricePaise: 249_900, types: ['AI_SEARCH_BOOST', 'AI_RECOMMENDATION_BOOST', 'SPIN360_PROMOTION'], placements: [] },
      LUXURY: { pricePaise: 499_900, types: ['AI_RECOMMENDATION_BOOST', 'TRYON_PROMOTION'], placements: ['HOMEPAGE_BANNER'] },
      ENTERPRISE: { pricePaise: 999_900, types: [], placements: [] },
    },
    placements: {
      HOMEPAGE_BANNER: { rangePaise: [50_000, 200_000], pricePaise: 100_000, unit: 'DAY', slots: 1, needsCreative: true, sponsorship: false },
      CATEGORY_BANNER: { rangePaise: [30_000, 150_000], pricePaise: 50_000, unit: 'DAY', slots: 1, needsCreative: true, sponsorship: false },
      FEATURED_SELLER: { rangePaise: [99_900, 499_900], pricePaise: 199_900, unit: 'CAMPAIGN', slots: 3, needsCreative: false, sponsorship: false },
      FLASH_SALE: { rangePaise: [29_900, 99_900], pricePaise: 49_900, unit: 'CAMPAIGN', slots: 4, needsCreative: true, sponsorship: false },
      NEW_COLLECTION: { rangePaise: [99_900, 399_900], pricePaise: 199_900, unit: 'CAMPAIGN', slots: 2, needsCreative: true, sponsorship: false },
      SP_BASIC_PRODUCT: { rangePaise: [0, 9_900], pricePaise: 4_900, unit: 'DAY', slots: 10, needsCreative: false, sponsorship: true },
      SP_CATEGORY_TOP: { rangePaise: [9_900, 9_900], pricePaise: 9_900, unit: 'DAY', slots: 1, needsCreative: false, sponsorship: true },
      SP_HOMEPAGE_FEATURED: { rangePaise: [19_900, 19_900], pricePaise: 19_900, unit: 'DAY', slots: 4, needsCreative: false, sponsorship: true },
      SP_HOMEPAGE_BANNER: { rangePaise: [49_900, 49_900], pricePaise: 49_900, unit: 'DAY', slots: 1, needsCreative: true, sponsorship: true },
      SP_BRAND_SPOTLIGHT: { rangePaise: [99_900, 99_900], pricePaise: 99_900, unit: 'WEEK', slots: 1, needsCreative: true, sponsorship: true },
      SP_FESTIVAL_CAMPAIGN: { rangePaise: [149_900, 149_900], pricePaise: 149_900, unit: 'WEEK', slots: 2, needsCreative: true, sponsorship: true },
    },
    welcomeCreditPaise: 50_000,
    attributionDays: 7,
  },
  sponsorship: { perClickRangePaise: [50, 150], premiumDiscountPercent: 50 },
  invoice: { sacCode: '998599', numberPrefix: 'CLW/SI' },
  tryon: {
    packs: [
      { credits: 100, pricePaise: 150_000 },
      { credits: 200, pricePaise: 270_000 },
      { credits: 300, pricePaise: 375_000 },
      { credits: 400, pricePaise: 460_000 },
      { credits: 500, pricePaise: 500_000 },
    ],
    extraCreditPaise: 900,
    expiryDays: null,
    freeGrantCredits: 50,
    freeGrantSellers: 51,
    costPerCreditPaise: 732,
    tierCostsPaise: [658, 585, 476],
    phaseNote: 'On-demand phase (FASHN pay-as-you-go).',
  },
};

/** A seller's plan, as the Plans page shows it. */
export interface SellerPlanView {
  plan: SellerPlan;
  autoRenew: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  pendingPlan: SellerPlan | null;
  graceUntil: string | null;
  /** Sellers from before the plans: every product stays live until then. */
  limitGraceUntil: string | null;
  liveProducts: number;
  hiddenByPlan: number;
  walletPaise: number;
  gstPercent: number;
  plans: Record<SellerPlan, PlanRules>;
}
export const sellerPlanChangeSchema = z.object({ plan: z.enum(SELLER_PLANS) });
export const aiMarketingSchema = z.object({
  productId: z.string().min(1),
  goal: z.string().trim().max(200).optional(),
});
/** The 360° view: images around the product, in order (Pro and Premium). */
export const spinImagesSchema = z.object({ imageUrls: z.array(z.string().trim().min(1).max(500)).max(72) });
export const sellerAutoRenewSchema = z.object({ autoRenew: z.boolean() });
export const sellerLiveProductsSchema = z.object({ productIds: z.array(z.string().min(1)).max(1000) });

/** Admin penalties (owner's Batch 2), each with a reason, deducted from payout. */
export const ADMIN_PENALTY_KINDS = ['COUNTERFEIT_LISTING', 'INACCURATE_TRYON_DATA'] as const;
export type AdminPenaltyKind = (typeof ADMIN_PENALTY_KINDS)[number];
export const ADMIN_PENALTY_LABELS: Record<AdminPenaltyKind, string> = {
  COUNTERFEIT_LISTING: 'Counterfeit or non-compliant listing',
  INACCURATE_TRYON_DATA: 'Inaccurate try-on data',
};
export const adminPenaltySchema = z.object({
  kind: z.enum(ADMIN_PENALTY_KINDS),
  reason: z.string().trim().min(5, 'Say why — the seller sees it').max(500),
  productId: z.string().optional(),
});
export const sellerVipSchema = z.object({ vip: z.boolean() });

/** The price calculator's rates: the current Batch 2 fees, and each category's referral fee. */
export interface PricingRatesView {
  /** Each category's flat referral percent: used where it has no fee-schedule slabs. */
  categoryReferralPercent: Record<string, number>;
  /** Categories charged under the referral fee schedule: their slabs, by unit price. */
  categoryReferralSlabs?: Record<string, CategoryReferralSlabs>;
}

/** A category's referral fee slabs under the schedule in force. */
export interface CategoryReferralSlabs {
  scheduleVersion: number;
  sheetCategory: string;
  slabs: ReferralFeeSlab[];
}

/** A partial update an admin sends: any section, any field. Merged over the current rules, then validated whole. */
export const commercialPatchSchema = z.record(z.string(), z.unknown());

/** Deep-merge a patch over the current rules (arrays and tuples are replaced, objects merged). */
export function mergeCommercial(current: CommercialSettings, patch: Record<string, unknown>): CommercialSettings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge(out[k], v);
      return out;
    }
    return b;
  };
  return commercialSettingsSchema.parse(merge(current, patch));
}

/** Each placement's price must sit inside its range. */
export function placementPriceProblems(c: CommercialSettings): string[] {
  return Object.entries(c.ads.placements)
    .filter(([, p]) => p.pricePaise < p.rangePaise[0] || p.pricePaise > p.rangePaise[1])
    .map(([k]) => `${PLACEMENT_LABELS[k as PlacementKind]}: price outside its range`);
}

/** The handling fee per unit for a unit selling price (GST included). */
export function handlingFeeFor(unitPricePaise: number, slabs: HandlingSlab[]): number {
  const sorted = [...slabs].sort((a, b) => a.fromPaise - b.fromPaise);
  let fee = sorted[0]?.feePaise ?? 0;
  for (const s of sorted) if (unitPricePaise >= s.fromPaise) fee = s.feePaise;
  return fee;
}

/** GST on a Clowe charge, rounded to the paisa. */
export function cloweGst(basePaise: number, gstPercent: number): number {
  return Math.round((basePaise * gstPercent) / 100);
}

export function planAllows(c: CommercialSettings, plan: SellerPlan, feature: PlanFeature): boolean {
  return c.plans[plan].features.includes(feature);
}

// --- Fee changes announced ahead (owner's Batch 2) ------------------------------------

export const feeChangeScheduleSchema = z.object({
  /** The part of the commercial rules that changes. */
  patch: z.record(z.string(), z.unknown()),
  effectiveAt: z.string().datetime({ offset: true }),
});

export interface FeeChangeView {
  id: string;
  /** One line per value that changes, "fees.gtPercent: 1.5 → 2". */
  summary: string;
  effectiveAt: string;
  status: 'SCHEDULED' | 'APPLIED' | 'CANCELLED';
  createdAt: string;
  appliedAt: string | null;
  cancelledAt: string | null;
}
