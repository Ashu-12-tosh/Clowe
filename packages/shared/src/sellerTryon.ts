// ---------------------------------------------------------------------------
// Seller AI Try-On insights
//
// A seller sees how shoppers use AI Try-On on THEIR products only — counts,
// ratings and per-product interest. Shopper identity, photos and platform
// costs are deliberately absent: sellers get demand signals, not private data.
// ---------------------------------------------------------------------------

export interface SellerTryOnMetric {
  value: number;
  previous: number;
  /** Percent change vs the previous period; null when there is no baseline. */
  changePercent: number | null;
}

export interface SellerTryOnTrendPoint {
  /** YYYY-MM-DD. */
  date: string;
  total: number;
  success: number;
}

export interface SellerTryOnProductRow {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  status: string;
  runs: number;
  /** Shopper verdicts on the result. */
  ratedUp: number;
  ratedDown: number;
  lastRunAt: string;
}

export interface SellerTryOnRecentRow {
  /** Reference like TR-20260901-AB12 — safe to show, carries no identity. */
  ref: string;
  productId: string;
  productTitle: string;
  productSlug: string;
  imageUrl: string | null;
  /** Variant the shopper was viewing, e.g. "Black · L"; "" when unknown. */
  variantLabel: string;
  status: string; // PENDING | SUCCESS | FAILED
  feedback: string | null; // UP | DOWN | null
  createdAt: string;
}

export interface SellerTryOnOverview {
  range: { from: string; to: string; days: number };
  metrics: {
    runs: SellerTryOnMetric;
    /** Distinct shoppers who tried products on (count only — no identities). */
    shoppers: SellerTryOnMetric;
    successRatePercent: number;
    ratedUp: number;
    ratedDown: number;
  };
  trend: SellerTryOnTrendPoint[];
  topProducts: SellerTryOnProductRow[];
  recent: SellerTryOnRecentRow[];
  /** True when none of this seller's products sit in a try-on eligible category. */
  tryOnUnavailable: boolean;
  credits: SellerTryOnCredits;
  /** Products in try-on eligible categories, with their caps and usage. */
  allocations: SellerTryOnAllocationRow[];
}

// ---------------------------------------------------------------------------
// Try-on credits: launch grant, per-product caps, purchasable packs
// ---------------------------------------------------------------------------

import { z } from 'zod';

// Packs, prices, the free grant and expiry are admin settings (commercial.tryon).

/** Buy a pack (by its credits): once, or every month on this date. */
export const sellerTryOnBuySchema = z.object({
  credits: z.number().int().min(1),
  autoRenew: z.boolean().default(false),
});
export type SellerTryOnBuyInput = z.infer<typeof sellerTryOnBuySchema>;

/** Change the monthly pack (its credits), or stop it (null). */
export const sellerTryOnAutoRenewSchema = z.object({ credits: z.number().int().min(1).nullable() });

/** Admin: credits above the biggest pack, charged at the per-credit rate unless waived. */
export const adminTryOnCreditsSchema = z.object({
  credits: z.number().int().min(1).max(100_000),
  charge: z.boolean(),
  note: z.string().trim().max(200).default(''),
});

/** Admin only: a month of try-on economics. */
export interface TryOnProfitReport {
  month: string;
  creditsSold: number;
  creditsGranted: number;
  /** Credits spent (one per successful run that was not a free repeat). */
  creditsUsed: number;
  successfulRuns: number;
  freeRepeats: number;
  failedRuns: number;
  /** What sellers paid for credits, before GST. */
  revenuePaise: number;
  /** As logged by the provider adapter for each run. */
  providerCostPaise: number;
  /** Successful runs × the admin's cost per credit. */
  estimatedCostPaise: number;
  profitPaise: number;
  costPerCreditPaise: number;
  tierCostsPaise: number[];
  phaseNote: string;
}

export const sellerTryOnLimitSchema = z.object({
  /** null clears the cap — the product uses the pool until it runs dry. */
  tryOnLimit: z.number().int().min(0).max(100000).nullable(),
});
export type SellerTryOnLimitInput = z.infer<typeof sellerTryOnLimitSchema>;

export interface SellerTryOnLedgerRow {
  delta: number;
  reason: string; // FREE_GRANT | PURCHASE | RUN
  note: string | null;
  createdAt: string;
}

export interface SellerTryOnCredits {
  /** Try-ons left in the pool across all products. */
  balance: number;
  /** True when this shop received the free credits for the first approved sellers. */
  freeGrant: boolean;
  ledger: SellerTryOnLedgerRow[];
  /** The packs on sale (before GST). */
  packs: { credits: number; pricePaise: number }[];
  /** The monthly pack, if any, and when it renews. */
  monthlyPackCredits: number | null;
  renewsAt: string | null;
  /** Credits lapse this many days after they are added; null = never. */
  expiryDays: number | null;
  /** Above the biggest pack, per credit, through vendor support. */
  extraCreditPaise: number;
  gstPercent: number;
}

/** One try-on-eligible product with its cap and usage. */
export interface SellerTryOnAllocationRow {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  status: string;
  tryOnEnabled: boolean;
  /** null = no per-product cap. */
  tryOnLimit: number | null;
  tryOnUsed: number;
}
