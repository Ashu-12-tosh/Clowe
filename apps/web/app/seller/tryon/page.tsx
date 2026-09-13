'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  TRYON_PACKS,
  type SellerTryOnMetric,
  type SellerTryOnOverview,
  type TryOnPackKey,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

const STATUS_STYLES: Record<string, string> = {
  SUCCESS: 'bg-green-100 text-green-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
  FAILED: 'bg-red-100 text-red-600',
};

const LEDGER_LABELS: Record<string, string> = {
  FREE_GRANT: '🎁 Free launch credits',
  PURCHASE: '🛒 Pack purchased',
  RUN: '✨ Shopper try-on',
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function Change({ metric }: { metric: SellerTryOnMetric }) {
  if (metric.changePercent === null) {
    return <span className="text-[11px] text-gray-400">no previous period</span>;
  }
  const up = metric.changePercent >= 0;
  return (
    <span className={`text-[11px] font-semibold ${up ? 'text-green-600' : 'text-red-600'}`}>
      {up ? '▲' : '▼'} {Math.abs(metric.changePercent)}% vs previous
    </span>
  );
}

/**
 * AI Try-On for this shop: the credit pool (50 free for the first 100 sellers,
 * packs after that), per-product caps, and how shoppers use try-on. Shopper
 * identity and photos are never shown here.
 */
export default function SellerTryOnPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<SellerTryOnOverview | null>(null);
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState('');
  const [buying, setBuying] = useState<TryOnPackKey | ''>('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<SellerTryOnOverview>(`/api/seller/tryon?days=${days}`, { auth: true })
      .then((d) => {
        setData(d);
        setLimitDrafts(
          Object.fromEntries(
            d.allocations.map((a) => [a.productId, a.tryOnLimit === null ? '' : String(a.tryOnLimit)]),
          ),
        );
      })
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load try-on insights'),
      );
  }, [days]);
  useEffect(load, [load]);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }

  async function saveLimit(productId: string) {
    const raw = (limitDrafts[productId] ?? '').trim();
    const tryOnLimit = raw === '' ? null : Math.max(0, Math.round(Number(raw)));
    if (raw !== '' && Number.isNaN(Number(raw))) return;
    setSavingId(productId);
    setError('');
    try {
      await api(`/api/seller/tryon/products/${productId}`, {
        method: 'PATCH',
        body: { tryOnLimit },
        auth: true,
      });
      flash(tryOnLimit === null ? 'Limit removed — uses the shared pool' : `Limit set to ${tryOnLimit}`);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save that limit');
    } finally {
      setSavingId('');
    }
  }

  async function buy(pack: TryOnPackKey) {
    setBuying(pack);
    setError('');
    try {
      const result = await api<{ balance: number; credits: number }>('/api/seller/tryon/buy', {
        method: 'POST',
        body: { pack },
        auth: true,
      });
      flash(`${result.credits} try-ons added — balance ${result.balance}`);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Purchase failed');
    } finally {
      setBuying('');
    }
  }

  if (error && !data) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-10 w-72 rounded-lg bg-cream-100" />
        <div className="h-64 rounded-2xl bg-cream-100" />
      </div>
    );
  }

  const maxTrend = Math.max(1, ...data.trend.map((t) => t.total));
  const balance = data.credits.balance;
  const tiles = [
    {
      label: 'Credits left',
      value: String(balance),
      extra:
        balance > 0 ? (
          <span className="text-[11px] text-gray-400">1 credit = 1 shopper try-on</span>
        ) : (
          <span className="text-[11px] font-semibold text-red-600">Buy a pack to keep try-on live</span>
        ),
      icon: '🪙',
    },
    {
      label: 'Try-on runs',
      value: String(data.metrics.runs.value),
      extra: <Change metric={data.metrics.runs} />,
      icon: '✨',
    },
    {
      label: 'Shoppers',
      value: String(data.metrics.shoppers.value),
      extra: <Change metric={data.metrics.shoppers} />,
      icon: '👥',
    },
    {
      label: 'Shopper verdicts',
      value: `👍 ${data.metrics.ratedUp} · 👎 ${data.metrics.ratedDown}`,
      extra: (
        <span className="text-[11px] text-gray-400">{data.metrics.successRatePercent}% success rate</span>
      ),
      icon: '🪞',
    },
  ];

  return (
    <div className="pb-10">
      {/* --- Header --------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">AI Try-On</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Your try-on credits, per-product limits and how shoppers use virtual try-on.
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-600"
        >
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {notice && (
        <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {notice}
        </div>
      )}
      {error && data && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {data.tryOnUnavailable && (
        <div className="mt-4 rounded-2xl border border-brand-100 bg-brand-50/50 p-4 text-sm text-gray-700">
          ✨ AI Try-On works in wearable categories (like Fashion). None of your current listings
          are in a try-on eligible category yet — list wearable products to show up here.
        </div>
      )}

      {/* --- KPI tiles ------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                {tile.label}
              </p>
              <span>{tile.icon}</span>
            </div>
            <p className="mt-2 font-display text-xl font-bold text-ink-900">{tile.value}</p>
            <p className="mt-1">{tile.extra}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {/* --- Per-product limits ------------------------------------- */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">Try-on limits per product</p>
            <p className="text-[11px] text-gray-400">
              Every shopper try-on uses 1 credit from your pool. Set a limit to cap how much a
              product can use — leave it blank for no cap.
            </p>
            {data.allocations.length === 0 ? (
              <p className="mt-3 text-xs text-gray-400">No try-on eligible products yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-gray-100">
                {data.allocations.map((p) => {
                  const capped = p.tryOnLimit != null && p.tryOnUsed >= p.tryOnLimit;
                  return (
                    <li key={p.productId} className="flex flex-wrap items-center gap-3 py-2.5">
                      {p.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.imageUrl}
                          alt=""
                          className="h-11 w-9 shrink-0 rounded-lg border border-gray-100 object-cover"
                        />
                      ) : (
                        <div className="h-11 w-9 shrink-0 rounded-lg bg-cream-100" />
                      )}
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/products/${p.slug}`}
                          className="line-clamp-1 text-sm font-semibold text-ink-900 hover:text-brand-600"
                        >
                          {p.title}
                        </Link>
                        <p className="text-[11px] text-gray-400">
                          Used {p.tryOnUsed}
                          {p.tryOnLimit != null && ` of ${p.tryOnLimit}`}
                          {!p.tryOnEnabled && ' · try-on off for this listing'}
                          {capped && ' · limit reached'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          value={limitDrafts[p.productId] ?? ''}
                          onChange={(e) =>
                            setLimitDrafts((prev) => ({ ...prev, [p.productId]: e.target.value }))
                          }
                          placeholder="No limit"
                          className="w-24 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-600"
                        />
                        <button
                          onClick={() => void saveLimit(p.productId)}
                          disabled={savingId === p.productId}
                          className="rounded-lg border border-ink-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide hover:bg-cream-100 disabled:opacity-50"
                        >
                          {savingId === p.productId ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* --- Daily trend ------------------------------------------- */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-ink-900">Runs per day</p>
              <p className="text-[11px] text-gray-400">▮ success · ▮ other</p>
            </div>
            <div className="mt-3 flex h-28 items-end gap-[2px]">
              {data.trend.map((t) => (
                <div
                  key={t.date}
                  title={`${t.date}: ${t.total} run(s), ${t.success} success`}
                  className="flex min-w-0 flex-1 flex-col justify-end gap-[1px]"
                >
                  <div
                    className="w-full rounded-t bg-brand-500"
                    style={{ height: `${(t.success / maxTrend) * 100}%` }}
                  />
                  <div
                    className="w-full bg-gray-200"
                    style={{ height: `${((t.total - t.success) / maxTrend) * 100}%` }}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* --- Top products ------------------------------------------ */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">Most tried-on products</p>
            {data.topProducts.length === 0 ? (
              <p className="mt-3 text-xs text-gray-400">No try-on runs in this period.</p>
            ) : (
              <ul className="mt-3 divide-y divide-gray-100">
                {data.topProducts.map((p, i) => (
                  <li key={p.productId} className="flex items-center gap-3 py-2.5">
                    <span className="w-5 shrink-0 text-center text-xs font-bold text-gray-400">
                      {i + 1}
                    </span>
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.imageUrl}
                        alt=""
                        className="h-11 w-9 shrink-0 rounded-lg border border-gray-100 object-cover"
                      />
                    ) : (
                      <div className="h-11 w-9 shrink-0 rounded-lg bg-cream-100" />
                    )}
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/products/${p.slug}`}
                        className="line-clamp-1 text-sm font-semibold text-ink-900 hover:text-brand-600"
                      >
                        {p.title}
                      </Link>
                      <p className="text-[11px] text-gray-400">Last tried {fmtDateTime(p.lastRunAt)}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-ink-900">{p.runs}</p>
                      <p className="text-[11px] text-gray-400">
                        👍 {p.ratedUp} · 👎 {p.ratedDown}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* --- Recent runs -------------------------------------------- */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">Recent try-ons</p>
            <p className="text-[11px] text-gray-400">
              Shopper identity and photos are never shared with sellers.
            </p>
            {data.recent.length === 0 ? (
              <p className="mt-3 text-xs text-gray-400">Nothing yet in this period.</p>
            ) : (
              <ul className="mt-3 divide-y divide-gray-100">
                {data.recent.map((r) => (
                  <li key={r.ref} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-1 text-sm text-ink-900">
                        <span className="font-mono text-xs text-brand-600">{r.ref}</span> ·{' '}
                        {r.productTitle}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {r.variantLabel ? `${r.variantLabel} · ` : ''}
                        {fmtDateTime(r.createdAt)}
                      </p>
                    </div>
                    {r.feedback && (
                      <span className="shrink-0">{r.feedback === 'UP' ? '👍' : '👎'}</span>
                    )}
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        STATUS_STYLES[r.status] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {r.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* --- Right rail: credits ------------------------------------- */}
        <aside className="space-y-4">
          <div className="rounded-2xl bg-ink-950 p-5 text-white">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-400">
              Try-on credits
            </p>
            <p className="mt-2 font-display text-3xl font-bold">{balance}</p>
            <p className="mt-1 text-xs text-gray-400">
              {data.credits.freeGrant
                ? 'Includes your 50 free early-seller try-ons.'
                : 'Each shopper try-on uses one credit.'}
            </p>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">Buy more try-ons</p>
            <p className="text-[11px] text-gray-400">
              Credits never expire and work across all your products.
            </p>
            <ul className="mt-3 space-y-2">
              {TRYON_PACKS.map((pack) => (
                <li
                  key={pack.key}
                  className="flex items-center justify-between gap-2 rounded-xl border border-gray-100 p-3"
                >
                  <div>
                    <p className="text-sm font-bold text-ink-900">
                      {pack.label} · {pack.credits} try-ons
                    </p>
                    <p className="text-[11px] text-gray-400">
                      {formatPaise(pack.pricePaise)} ·{' '}
                      {formatPaise(Math.round(pack.pricePaise / pack.credits))} each
                    </p>
                  </div>
                  <button
                    onClick={() => void buy(pack.key)}
                    disabled={buying !== ''}
                    className="rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {buying === pack.key ? 'Buying…' : 'Buy'}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">Credit history</p>
            {data.credits.ledger.length === 0 ? (
              <p className="mt-3 text-xs text-gray-400">No movements yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-gray-100">
                {data.credits.ledger.map((l, i) => (
                  <li key={i} className="flex items-start justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-ink-900">
                        {LEDGER_LABELS[l.reason] ?? l.reason}
                      </p>
                      {l.note && <p className="line-clamp-1 text-[11px] text-gray-400">{l.note}</p>}
                      <p className="text-[11px] text-gray-400">{fmtDateTime(l.createdAt)}</p>
                    </div>
                    <span
                      className={`shrink-0 text-sm font-bold ${
                        l.delta >= 0 ? 'text-green-600' : 'text-gray-500'
                      }`}
                    >
                      {l.delta >= 0 ? `+${l.delta}` : l.delta}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
