import type { SearchMeta } from '@clowe/shared';
import { prisma } from '../db';

/**
 * What shoppers searched for, recorded in aggregate.
 *
 * The point is the zero-result list: queries the catalog could not answer are
 * how the synonym map gets better. Which individual person searched for what
 * is not needed for that, so none of it is stored — no user id, no IP, no
 * session, no user agent, no request id. A row cannot be traced back to anyone.
 *
 * Logging is fire-and-forget by design. A search is on the request path and
 * Chunk 3's whole point was keeping it fast; an analytics write must never
 * spend that budget, and must never be the reason a search fails.
 */

/** Rows older than this are swept. Long enough to spot a pattern, short enough
 *  that a free-text log does not become an archive. */
export const SEARCH_LOG_RETENTION_DAYS = 90;

/** Whitespace-collapsed lowercase, so "  Best  Phone " groups with "best phone". */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Record one results-page search.
 *
 * Never awaited by the caller and never throws: every failure path ends in a
 * console line. If the analytics table is missing, full, or slow, searches
 * carry on working exactly as before.
 *
 * Suggest-endpoint keystrokes deliberately do not come through here — that
 * fires per character and would fill the table with prefixes of real queries.
 */
export function logSearch(raw: string, meta: SearchMeta, resultCount: number): void {
  const query = raw.trim();
  if (!query) return;

  void prisma.searchQuery
    .create({
      data: {
        query: query.slice(0, 200),
        normalized: normalizeQuery(query).slice(0, 200),
        // The parsed filters, not the person: price bounds, brands, the
        // inferred category, the sort. Kept so a zero-result row stays
        // diagnosable after the parser itself has changed.
        parsedFilters: {
          ...meta.parsed.filters,
          sort: meta.parsed.sort,
          keywords: meta.parsed.cleanedKeywords,
        },
        resultCount,
        strategy: meta.strategy,
        relaxed: meta.relaxed !== null,
      },
    })
    .catch((err: unknown) => {
      // Swallowed on purpose. A failed write here is a lost data point, not a
      // failed search, and the caller has already responded by now anyway.
      console.error('[clowe-api] search log failed:', err);
    });
}

/** Delete logged searches past their retention; returns how many went. */
export async function sweepExpiredSearchLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - SEARCH_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.searchQuery.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

/** Run once at boot, then daily. Failures are logged, never fatal. */
export function startSearchLogCleanup(): void {
  const run = () => {
    sweepExpiredSearchLogs()
      .then((removed) => {
        if (removed > 0) console.log(`[clowe-api] expired search logs removed: ${removed}`);
      })
      .catch((err) => console.error('[clowe-api] search log sweep failed:', err));
  };
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
}
