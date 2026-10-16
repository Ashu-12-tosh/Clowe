import { z } from 'zod';
import { AD_PACKAGES, CPC_AD_TYPES, PLACEMENT_KINDS, type CpcAdType, type PlacementKind } from './commercial';
import type { ProductListItem } from './catalog';

// ---------------------------------------------------------------------------
// Advertising and sponsorship (owner's Batch 2): inputs and views.
// Every paid item a shopper sees sits in a slot labelled "Sponsored" or "Ad";
// organic results and ranking are never touched.
// ---------------------------------------------------------------------------

/** Where ads are served. */
export const AD_SURFACES = ['SEARCH', 'CATEGORY', 'PRODUCT', 'HOME', 'TRYON', 'COMPARE'] as const;
export type AdSurface = (typeof AD_SURFACES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-01');
const paise = z.number().int().min(0);

export const cpcCampaignSchema = z.object({
  name: z.string().trim().min(2).max(80),
  adTypes: z.array(z.enum(CPC_AD_TYPES)).min(1, 'Pick at least one ad type'),
  productId: z.string().min(1),
  bidPaise: z.number().int().min(1),
  dailyBudgetPaise: z.number().int().min(100),
  monthlyBudgetPaise: paise.optional(),
  /** Sponsorship's per-click "Sponsored Product" (its own rate card). */
  sponsorship: z.boolean().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
});

export const smartCampaignSchema = z.object({
  name: z.string().trim().min(2).max(80),
  productId: z.string().min(1),
  totalBudgetPaise: z.number().int().min(10_000, 'A smart campaign needs at least ₹100'),
  days: z.number().int().min(1).max(90),
  goal: z.enum(['CLICKS', 'ORDERS']),
});

export const adPackageBuySchema = z.object({
  package: z.enum(AD_PACKAGES),
  productId: z.string().min(1),
  startDate: isoDate,
  creativeUrl: z.string().trim().max(500).optional(),
  headline: z.string().trim().max(80).optional(),
});

export const placementBookSchema = z.object({
  placement: z.enum(PLACEMENT_KINDS),
  startDate: isoDate,
  /** Days for a DAY placement, weeks for a WEEK one; 1 for a CAMPAIGN one. */
  units: z.number().int().min(1).max(60),
  categoryId: z.string().optional(),
  productId: z.string().optional(),
  creativeUrl: z.string().trim().max(500).optional(),
  headline: z.string().trim().max(80).optional(),
});

export const adCampaignUpdateSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
  name: z.string().trim().min(2).max(80).optional(),
  bidPaise: z.number().int().min(1).optional(),
  dailyBudgetPaise: z.number().int().min(100).optional(),
  monthlyBudgetPaise: paise.nullable().optional(),
});

export const adClickSchema = z.object({
  campaignId: z.string().min(1),
  productId: z.string().optional(),
  /** A random id the browser keeps, so one device's clicks count once. */
  deviceId: z.string().min(8).max(64),
  slotType: z.string().max(40),
});

export const adImpressionsSchema = z.object({
  items: z.array(z.object({ campaignId: z.string().min(1), slotType: z.string().max(40) })).max(50),
});

export const adReviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(300).optional(),
});

export type AdLabel = 'Sponsored' | 'Ad';

export interface AdServeItem {
  campaignId: string;
  slotType: string;
  label: AdLabel;
  product: ProductListItem;
}

export interface AdServeBanner {
  campaignId: string;
  slotType: string;
  label: AdLabel;
  creativeUrl: string | null;
  headline: string | null;
  /** Where the banner leads: the product, or the seller's store. */
  href: string;
}

export interface AdServeResponse {
  /** The labelled slot at the very top (Top Search Placement), if any. */
  top: AdServeItem[];
  items: AdServeItem[];
  banners: AdServeBanner[];
}

export interface AdMetrics {
  impressions: number;
  clicks: number;
  /** Clicks per impression, percent. */
  ctr: number;
  avgCpcPaise: number;
  orders: number;
  spendPaise: number;
  revenuePaise: number;
  /** Revenue per rupee spent. */
  roas: number;
}

export interface AdCampaignRow {
  id: string;
  name: string;
  kind: 'CPC' | 'PACKAGE' | 'PLACEMENT' | 'SMART';
  sponsorship: boolean;
  adTypes: CpcAdType[];
  placement: PlacementKind | null;
  packageKey: string | null;
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'REJECTED';
  rejectionReason: string | null;
  productTitle: string | null;
  bidPaise: number | null;
  dailyBudgetPaise: number | null;
  monthlyBudgetPaise: number | null;
  pricePaise: number;
  startAt: string;
  endAt: string | null;
  metrics: AdMetrics;
}

export interface AdsOverview {
  totals: AdMetrics;
  /** Per slot type — the AI Search and Recommendation performance among them. */
  byType: (AdMetrics & { slotType: string })[];
  campaigns: AdCampaignRow[];
  adCreditPaise: number;
  walletPaise: number;
}

export interface SlotAvailability {
  placement: PlacementKind;
  days: { date: string; free: number; slots: number }[];
}

/** Metrics from raw counts. */
export function adMetrics(c: { impressions: number; clicks: number; orders: number; spendPaise: number; revenuePaise: number }): AdMetrics {
  return {
    ...c,
    ctr: c.impressions > 0 ? Math.round((c.clicks / c.impressions) * 10_000) / 100 : 0,
    avgCpcPaise: c.clicks > 0 ? Math.round(c.spendPaise / c.clicks) : 0,
    roas: c.spendPaise > 0 ? Math.round((c.revenuePaise / c.spendPaise) * 100) / 100 : 0,
  };
}
