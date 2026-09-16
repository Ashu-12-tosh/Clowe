'use client';

/**
 * Search analytics.
 *
 * The zero-result list is the working surface: every row is a shopper who
 * wanted something and found nothing. Each one is either a word the synonym
 * map does not know, a product titled differently from how people ask for it,
 * or a genuine gap in the catalog — and the query text usually says which.
 *
 * Nothing here can be broken down by person, because the underlying rows hold
 * nothing identifying.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SearchAnalyticsView, SearchQueryStat } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const WINDOWS = [7, 30, 90];

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function QueryTable({
  rows,
  emptyMessage,
  showStrategy,
}: {
  rows: SearchQueryStat[];
  emptyMessage: string;
  showStrategy?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-gray-500">{emptyMessage}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-400">
            <th className="px-4 py-2 font-semibold">Query</th>
            <th className="px-4 py-2 text-right font-semibold">Searches</th>
            {showStrategy && <th className="px-4 py-2 font-semibold">Matched by</th>}
            <th className="px-4 py-2 text-right font-semibold">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.normalized} className="border-b border-gray-50 last:border-0">
              <td className="px-4 py-2.5">
                <span className="font-medium text-ink-900">{row.sample}</span>
                {row.sample.toLowerCase() !== row.normalized && (
                  <span className="ml-2 text-xs text-gray-400">({row.normalized})</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right font-bold text-ink-900">{row.count}</td>
              {showStrategy && (
                <td className="px-4 py-2.5">
                  <span className="rounded-md bg-cream-100 px-1.5 py-0.5 text-xs text-gray-600">
                    {row.strategy}
                  </span>
                </td>
              )}
              <td className="px-4 py-2.5 text-right text-xs text-gray-500">{timeAgo(row.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminSearchPage() {
  const [days, setDays] = useState(30);
  const [view, setView] = useState<SearchAnalyticsView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api<SearchAnalyticsView>(`/api/admin/search/analytics?days=${days}`, { auth: true })
      .then((data) => {
        setView(data);
        setError('');
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load analytics'))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(load, [load]);

  const zeroShare =
    view && view.summary.total > 0
      ? Math.round((view.summary.zeroResult / view.summary.total) * 100)
      : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-page-title text-ink-900">Search</h1>
          <p className="mt-1 text-sm text-gray-500">
            What shoppers looked for, and what the catalog could not answer.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 p-0.5">
          {WINDOWS.map((window) => (
            <button
              key={window}
              onClick={() => setDays(window)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                days === window ? 'bg-ink-900 text-white' : 'text-gray-600 hover:bg-cream-100'
              }`}
            >
              {window}d
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {loading && !view && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))}
        </div>
      )}

      {view && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Searches" value={String(view.summary.total)} hint={`last ${view.days} days`} />
            <Stat
              label="Found nothing"
              value={String(view.summary.zeroResult)}
              hint={`${zeroShare}% of searches`}
            />
            <Stat
              label="Needed loosening"
              value={String(view.summary.relaxed)}
              hint="a filter had to be dropped"
            />
            <Stat
              label="Matched by typo"
              value={String(view.summary.trigram)}
              hint="spelling did not match exactly"
            />
          </div>

          <section className="rounded-2xl border border-gray-100 bg-white">
            <div className="border-b border-gray-100 px-4 py-3">
              <h2 className="text-sm font-bold text-ink-900">Queries that found nothing</h2>
              <p className="mt-0.5 text-xs text-gray-500">
                Most frequent first. Each one is a missing synonym, a product worded differently
                from how people ask for it, or a real gap in the catalog. Synonyms live in{' '}
                <code className="rounded bg-cream-100 px-1 py-0.5 text-[11px]">
                  packages/shared/src/searchQuery.ts
                </code>
                .
              </p>
            </div>
            <QueryTable
              rows={view.zeroResultQueries}
              emptyMessage={`No failed searches in the last ${view.days} days.`}
            />
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white">
            <div className="border-b border-gray-100 px-4 py-3">
              <h2 className="text-sm font-bold text-ink-900">Most searched</h2>
              <p className="mt-0.5 text-xs text-gray-500">
                For context — what the search bar is mostly being used for.
              </p>
            </div>
            <QueryTable
              rows={view.topQueries}
              emptyMessage={`No searches recorded in the last ${view.days} days.`}
              showStrategy
            />
          </section>

          <p className="text-xs text-gray-400">
            Searches are stored without any identifying data — no account, no IP, no session — and
            are deleted after 90 days.
          </p>
        </>
      )}
    </div>
  );
}
