import { z } from 'zod';
import type { ProductListItem } from './catalog';

// ---------------------------------------------------------------------------
// AI with Gemini (owner's overnight run): a monthly budget, per-user daily
// limits, usage and cost; AI Search (a question → filters + one line, real
// catalog products only) and Compare (up to 4 products, an optional summary
// built only from their data).
// ---------------------------------------------------------------------------

export const aiSettingsSchema = z.object({
  /** Spend cap for a calendar month (India time), all AI calls together. */
  monthlyBudgetPaise: z.number().int().min(0),
  /** For turning the provider's USD prices into rupees. */
  usdInrRate: z.number().positive().max(500),
  /** The model's price per million tokens, in USD (input and output). */
  inputUsdPerMillion: z.number().min(0).max(100),
  outputUsdPerMillion: z.number().min(0).max(100),
  /** AI calls a day for one shopper (or one signed-out device/IP), and for one seller. */
  shopperDailyCalls: z.number().int().min(0).max(10_000),
  sellerDailyCalls: z.number().int().min(0).max(10_000),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

/** gemini-3.5-flash-lite at Google's published paid-tier prices (Oct 2026). */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  monthlyBudgetPaise: 100_000,
  usdInrRate: 88,
  inputUsdPerMillion: 0.3,
  outputUsdPerMillion: 2.5,
  shopperDailyCalls: 30,
  sellerDailyCalls: 60,
};

export const aiSettingsPatchSchema = aiSettingsSchema.partial();

/** Cost of one call in paise (fractions kept). */
export function aiCallCostPaise(s: Pick<AiSettings, 'usdInrRate' | 'inputUsdPerMillion' | 'outputUsdPerMillion'>, inputTokens: number, outputTokens: number): number {
  const usd = (inputTokens * s.inputUsdPerMillion + outputTokens * s.outputUsdPerMillion) / 1_000_000;
  return usd * s.usdInrRate * 100;
}

export interface AiUsageView {
  month: string;
  provider: string;
  model: string;
  settings: AiSettings;
  spentPaise: number;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  byTask: { task: string; calls: number; costPaise: number }[];
  byDay: { day: string; calls: number; costPaise: number }[];
  recent: { at: string; task: string; inputTokens: number; outputTokens: number; costPaise: number; ok: boolean }[];
}

// --- AI Search -------------------------------------------------------------------------

export const aiSearchSchema = z.object({ q: z.string().trim().min(2).max(200) });

/** What the model turned the question into; every value checked against the catalog. */
export interface AiSearchFilters {
  q: string;
  category: string | null;
  minPricePaise: number | null;
  maxPricePaise: number | null;
  colors: string[];
}

export interface AiSearchResult {
  query: string;
  /** False when AI is unavailable (budget, limit, error): a plain search answered instead. */
  ai: boolean;
  /** One line restating what was searched for; never a claim about a product. */
  answer: string | null;
  filters: AiSearchFilters;
  /** Products from sellers whose plan includes AI search visibility. */
  items: ProductListItem[];
  /** The same search across every seller, below the AI picks. */
  more: ProductListItem[];
}

// --- Compare ---------------------------------------------------------------------------

export const COMPARE_MAX = 4;
export const compareIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(COMPARE_MAX) });
export const compareSummarySchema = compareIdsSchema.extend({ needs: z.string().trim().max(300).optional() });

export interface CompareProduct {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  categoryName: string;
  /** The cheapest live variant, GST included, and its MRP. */
  pricePaise: number;
  mrpPaise: number | null;
  priceVaries: boolean;
  ratingAvg: number | null;
  ratingCount: number;
  sellerName: string;
  /** "Returnable within N days for defects…" or "Not returnable". */
  returns: string;
  /** Key attributes from the category's attribute schema, by label. */
  attributes: Record<string, string>;
  inStock: boolean;
}

export interface CompareView {
  products: CompareProduct[];
  /** Every attribute label any of them has, in schema order. */
  attributeLabels: string[];
}
