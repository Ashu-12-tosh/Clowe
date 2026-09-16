import { z } from 'zod';

/**
 * Search analytics for the admin console.
 *
 * The headline view is queries that returned nothing: each one is a shopper
 * who wanted something and left empty-handed, and the list is the input to
 * improving the synonym map.
 */

export const searchAnalyticsQuerySchema = z.object({
  /** How far back to look. */
  days: z.coerce.number().int().min(1).max(90).default(30),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SearchAnalyticsQuery = z.infer<typeof searchAnalyticsQuerySchema>;

export interface SearchQueryStat {
  /** Normalised form — what identical searches grouped on. */
  normalized: string;
  /** A representative raw spelling, for reading. */
  sample: string;
  count: number;
  lastSeen: string;
  /** Which path answered it most recently. */
  strategy: string;
}

export interface SearchAnalyticsSummary {
  /** Searches in the window. */
  total: number;
  /** How many of those returned nothing. */
  zeroResult: number;
  /** How many needed a filter dropped to return anything. */
  relaxed: number;
  /** Share of searches answered by the typo fallback rather than full text. */
  trigram: number;
}

export interface SearchAnalyticsView {
  days: number;
  summary: SearchAnalyticsSummary;
  /** Queries that returned nothing, most frequent first. */
  zeroResultQueries: SearchQueryStat[];
  /** The busiest queries overall, for context. */
  topQueries: SearchQueryStat[];
}
