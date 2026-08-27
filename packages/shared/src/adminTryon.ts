import { z } from 'zod';
import type { TryOnFeedback } from './tryon';

// ---------------------------------------------------------------------------
// AI Try-On Monitor (admin) — every number here is computed from the
// tryon_history table, so the dashboard always mirrors real platform usage.
// ---------------------------------------------------------------------------

export const TRYON_DEVICE_TYPES = ['MOBILE', 'TABLET', 'DESKTOP', 'OTHER'] as const;
export type TryOnDeviceType = (typeof TRYON_DEVICE_TYPES)[number];

export const TRYON_DEVICE_LABELS: Record<TryOnDeviceType, string> = {
  MOBILE: 'Mobile',
  TABLET: 'Tablet',
  DESKTOP: 'Desktop',
  OTHER: 'Other',
};

export const TRYON_STATUSES = ['PENDING', 'SUCCESS', 'FAILED'] as const;
export type TryOnStatusValue = (typeof TRYON_STATUSES)[number];

/** Tabs above the requests table. */
export const TRYON_MONITOR_TABS = ['RECENT', 'FAILED', 'FLAGGED', 'RATED_DOWN'] as const;
export type TryOnMonitorTab = (typeof TRYON_MONITOR_TABS)[number];

export const TRYON_MONITOR_TAB_LABELS: Record<TryOnMonitorTab, string> = {
  RECENT: 'Recent Try-On Requests',
  FAILED: 'Failed Generations',
  FLAGGED: 'Flagged Content',
  RATED_DOWN: 'Poor Fit Reports',
};

/** Query filters shared by the overview, the table and the CSV export. */
export interface AdminTryOnFilters {
  from?: string; // ISO date (inclusive)
  to?: string; // ISO date (inclusive)
  provider?: string;
  categoryId?: string;
  gender?: string;
  device?: TryOnDeviceType;
  status?: TryOnStatusValue;
  q?: string;
}

/** A KPI with its value in the previous window of equal length. */
export interface AdminTryOnMetric {
  value: number;
  previous: number;
  /** null when the previous window had nothing to compare against. */
  changePercent: number | null;
}

export interface AdminTryOnShare {
  key: string;
  label: string;
  count: number;
  /** 0–100, share of the filtered total. */
  share: number;
}

export interface AdminTryOnHealthCheck {
  key: string;
  label: string;
  status: 'OPERATIONAL' | 'DEGRADED' | 'DOWN';
  detail: string;
}

export interface AdminTryOnHealth {
  overall: 'OPERATIONAL' | 'DEGRADED' | 'DOWN';
  checks: AdminTryOnHealthCheck[];
}

export interface AdminTryOnOverview {
  range: {
    from: string;
    to: string;
    days: number;
    previousFrom: string;
    previousTo: string;
  };
  kpis: {
    total: AdminTryOnMetric;
    uniqueUsers: AdminTryOnMetric;
    success: AdminTryOnMetric;
    failed: AdminTryOnMetric;
    costPaise: AdminTryOnMetric;
    avgDurationMs: AdminTryOnMetric;
    successRate: number;
    failureRate: number;
  };
  /** One point per day in the range. */
  trend: { date: string; total: number; success: number; failed: number }[];
  /** Average generation time per day (successful runs only). */
  latency: { date: string; avgMs: number }[];
  categories: AdminTryOnShare[];
  gender: AdminTryOnShare[];
  devices: AdminTryOnShare[];
  providers: {
    provider: string;
    total: number;
    success: number;
    successRate: number;
    avgDurationMs: number;
    costPaise: number;
  }[];
  quality: {
    /** Composite 0–5 score built from the bars below. */
    score: number;
    ratedCount: number;
    up: number;
    down: number;
    bars: { key: string; label: string; value: number; detail: string }[];
  };
  topUsers: {
    userId: string;
    name: string | null;
    phone: string;
    total: number;
    success: number;
    failed: number;
    successRate: number;
  }[];
  topProducts: {
    productId: string;
    title: string;
    slug: string;
    total: number;
    upVotes: number;
    downVotes: number;
  }[];
  abuse: {
    flagged: number;
    failed: number;
    ratedDown: number;
    blockedByQuota: number;
  };
  health: AdminTryOnHealth;
}

export interface AdminTryOnRequestRow {
  id: string;
  /** Human-readable reference, e.g. TR-20260803-0042. */
  requestId: string;
  userId: string;
  userName: string | null;
  userPhone: string;
  userGender: string | null;
  productId: string;
  productTitle: string;
  productSlug: string;
  categoryName: string;
  inputImageUrl: string;
  resultImageUrl: string | null;
  status: TryOnStatusValue;
  provider: string;
  durationMs: number | null;
  costPaise: number;
  deviceType: TryOnDeviceType | null;
  feedback: TryOnFeedback | null;
  flagged: boolean;
  flagReason: string | null;
  errorMessage: string | null;
  variantSize: string | null;
  variantColor: string | null;
  createdAt: string;
}

export interface AdminTryOnRequestPage {
  rows: AdminTryOnRequestRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** GET /api/admin/tryon/requests/:id — row plus context for the drawer. */
export interface AdminTryOnRequestDetail extends AdminTryOnRequestRow {
  userEmail: string | null;
  userJoinedAt: string;
  userTotalTryOns: number;
  productPricePaise: number;
  productBrand: string | null;
  sellerShopName: string | null;
}

/** GET /api/admin/tryon/filters — dropdown options with real data behind them. */
export interface AdminTryOnFilterOptions {
  providers: { provider: string; count: number }[];
  categories: { id: string; name: string; parentId: string | null }[];
}

export const adminTryOnFlagSchema = z.object({
  flagged: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});
export type AdminTryOnFlagInput = z.infer<typeof adminTryOnFlagSchema>;

/** Live controls for the try-on feature (Model Settings / Usage Limits). */
export interface AdminTryOnSettings {
  /** Kill switch — when false the storefront refuses new runs. */
  enabled: boolean;
  dailyLimitPerUser: number;
  minPricePaise: number;
  /** 0 = unlimited. Runs stop once the month's logged cost exceeds this. */
  monthlyBudgetPaise: number;
  /** Read-only, from the API's provider configuration. */
  provider: string;
  costPaisePerRun: number;
  monthSpendPaise: number;
  monthRuns: number;
}

export const adminTryOnSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  dailyLimitPerUser: z.number().int().min(1).max(500).optional(),
  minPricePaise: z.number().int().min(0).optional(),
  monthlyBudgetPaise: z.number().int().min(0).optional(),
});
export type AdminTryOnSettingsInput = z.infer<typeof adminTryOnSettingsSchema>;
