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

/** How many of the earliest sellers get the free launch credits. */
export const TRYON_FREE_GRANT_SELLERS = 100;
export const TRYON_FREE_GRANT_CREDITS = 50;

export const TRYON_PACKS = [
  { key: 'S', credits: 50, pricePaise: 29900, label: 'Starter' },
  { key: 'M', credits: 200, pricePaise: 99900, label: 'Growth' },
  { key: 'L', credits: 500, pricePaise: 199900, label: 'Pro' },
] as const;
export type TryOnPackKey = (typeof TRYON_PACKS)[number]['key'];

export const sellerTryOnBuySchema = z.object({
  pack: z.enum(['S', 'M', 'L']),
});
export type SellerTryOnBuyInput = z.infer<typeof sellerTryOnBuySchema>;

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
  /** True when this shop received the first-100-sellers launch offer. */
  freeGrant: boolean;
  ledger: SellerTryOnLedgerRow[];
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
