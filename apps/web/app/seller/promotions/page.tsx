'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  PROMOTION_STATUS_LABELS,
  PROMOTION_TABS,
  PROMOTION_TAB_LABELS,
  type PromotionStatusValue,
  type PromotionTab,
  type SellerPromotionPage,
  type SellerPromotionRow,
  type SellerPromotionSummary,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { DonutChart } from '@/components/charts/Charts';
import PromotionModal from '@/components/seller/promotions/PromotionModal';

const STATUS_STYLES: Record<PromotionStatusValue, string> = {
  RUNNING: 'bg-green-100 text-green-700',
  SCHEDULED: 'bg-blue-100 text-blue-700',
  PAUSED: 'bg-yellow-100 text-yellow-700',
  EXPIRED: 'bg-gray-100 text-gray-600',
  DRAFT: 'bg-cream-200 text-ink-900',
};

const TIPS = [
  'Automatic promotions (no code) convert better than codes shoppers must remember.',
  'Cap percentage offers so one large order does not swallow your margin.',
  'Short windows create urgency — a weekend beats a whole month.',
  'Target slow-moving products instead of your bestsellers.',
];

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function Delta({ change }: { change: number | null }) {
  if (change === null) return <span className="text-gray-400">no prior month</span>;
  return (
    <span className={change >= 0 ? 'text-green-600' : 'text-red-600'}>
      {change >= 0 ? '↑' : '↓'} {Math.abs(change)}% vs last month
    </span>
  );
}

function KpiCard({
  icon,
  label,
  value,
  footer,
}: {
  icon: string;
  label: string;
  value: string;
  footer: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cream-100 text-base">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium uppercase tracking-wide text-gray-500">
            {label}
          </p>
          <p className="mt-0.5 truncate font-display text-lg font-bold text-ink-900">{value}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">{footer}</p>
    </div>
  );
}

/** "20% OFF, max ₹500" — the human reading of the discount rule. */
function discountLabel(row: SellerPromotionRow): string {
  const base = row.kind === 'PERCENT' ? `${row.value}% OFF` : `${formatPaise(row.value)} OFF`;
  return row.maxDiscountPaise ? `${base} · max ${formatPaise(row.maxDiscountPaise)}` : base;
}

export default function SellerPromotionsPage() {
  const [tab, setTab] = useState<PromotionTab>('ALL');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);

  const [data, setData] = useState<SellerPromotionPage | null>(null);
  const [summary, setSummary] = useState<SellerPromotionSummary | null>(null);
  const [editing, setEditing] = useState<SellerPromotionRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadList = useCallback(async () => {
    try {
      const params = new URLSearchParams({ tab, page: String(page), pageSize: String(pageSize) });
      if (q.trim()) params.set('q', q.trim());
      setData(await api<SellerPromotionPage>(`/api/seller/promotions?${params}`, { auth: true }));
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load promotions');
      setData(null);
    }
  }, [tab, q, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<SellerPromotionSummary>('/api/seller/promotions/summary', { auth: true }));
    } catch {
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void loadList(), 250);
    return () => clearTimeout(t);
  }, [loadList]);
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);
  useEffect(() => setPage(1), [tab, q]);

  async function setState(row: SellerPromotionRow, state: 'ACTIVE' | 'PAUSED' | 'DRAFT') {
    setBusyId(row.id);
    try {
      await api(`/api/seller/promotions/${row.id}/state`, {
        method: 'PATCH',
        body: { state },
        auth: true,
      });
      await Promise.all([loadList(), loadSummary()]);
      setNotice(`"${row.name}" is now ${state.toLowerCase()}.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update the promotion');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: SellerPromotionRow) {
    const used = row.usedCount > 0;
    if (
      !confirm(
        used
          ? `"${row.name}" has been used ${row.usedCount} time(s), so it will be ended rather than deleted. Continue?`
          : `Delete "${row.name}"?`,
      )
    ) {
      return;
    }
    setBusyId(row.id);
    try {
      await api(`/api/seller/promotions/${row.id}`, { method: 'DELETE', auth: true });
      await Promise.all([loadList(), loadSummary()]);
      setNotice(used ? 'Promotion ended.' : 'Promotion deleted.');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not remove the promotion');
    } finally {
      setBusyId(null);
    }
  }

  const k = summary?.kpis;

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Promotions &amp; Discounts</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Run discounts on your own listings. The saving comes off your line price at checkout.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/seller/ads"
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            📣 Ads manager
          </Link>
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700"
          >
            ＋ Create promotion
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">
          ✓ {notice}
        </p>
      )}

      {/* --- KPIs -------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {k ? (
          <>
            <KpiCard
              icon="🏷"
              label="Active promotions"
              value={String(k.active)}
              footer={
                k.newThisMonth > 0 ? `${k.newThisMonth} new this month` : 'None created this month'
              }
            />
            <KpiCard
              icon="🎟"
              label="Total redemptions"
              value={k.redemptions.toLocaleString('en-IN')}
              footer={<Delta change={k.redemptionsChangePercent} />}
            />
            <KpiCard
              icon="💸"
              label="Discount given"
              value={formatPaise(k.discountGivenPaise)}
              footer={<Delta change={k.discountChangePercent} />}
            />
            <KpiCard
              icon="🛒"
              label="Sales from promotions"
              value={formatPaise(k.salesFromPromotionsPaise)}
              footer={<Delta change={k.salesChangePercent} />}
            />
            <KpiCard
              icon="📈"
              label="Return on discount"
              value={k.roi != null ? `${k.roi.toFixed(2)}×` : '—'}
              footer="Sales generated per ₹1 of discount"
            />
          </>
        ) : (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <div className="xl:col-span-3">
          {/* --- Tabs + search ------------------------------------------- */}
          <div className="rounded-t-2xl border border-b-0 border-gray-100 bg-white px-3 pt-3">
            <div className="flex flex-wrap gap-1">
              {PROMOTION_TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded-t-lg px-3 py-2 text-xs font-semibold ${
                    tab === t
                      ? 'border-b-2 border-brand-600 text-brand-600'
                      : 'text-gray-500 hover:text-ink-900'
                  }`}
                >
                  {PROMOTION_TAB_LABELS[t]}
                  {summary && summary.counts[t] > 0 && (
                    <span className="ml-1 text-gray-400">({summary.counts[t]})</span>
                  )}
                </button>
              ))}
            </div>
            <div className="border-t border-gray-100 py-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search promotions by name or code…"
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
              />
            </div>
          </div>

          {/* --- Table --------------------------------------------------- */}
          <div className="overflow-x-auto rounded-b-2xl border border-gray-100 bg-white">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-left uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2.5 font-semibold">Promotion</th>
                  <th className="px-3 py-2.5 font-semibold">Applies to</th>
                  <th className="px-3 py-2.5 font-semibold">Discount</th>
                  <th className="px-3 py-2.5 font-semibold">Valid period</th>
                  <th className="px-3 py-2.5 font-semibold">Usage</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Sales</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((row) => {
                  const usagePercent =
                    row.usageLimit && row.usageLimit > 0
                      ? Math.min(100, Math.round((row.usedCount / row.usageLimit) * 100))
                      : null;
                  return (
                    <tr key={row.id} className="border-t border-gray-100 hover:bg-cream-50">
                      <td className="px-3 py-2.5">
                        <p className="font-semibold text-ink-900">
                          {row.name}
                          {row.isFeatured && (
                            <span className="ml-1.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-700">
                              Featured
                            </span>
                          )}
                        </p>
                        <p className="text-[11px] text-gray-400">
                          {row.code ? (
                            <>
                              Code <span className="font-mono font-semibold">{row.code}</span>
                            </>
                          ) : (
                            'Applies automatically'
                          )}
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-gray-600">
                        {row.scopeLabel}
                        {row.scope === 'PRODUCT' && (
                          <span className="block text-[11px] text-gray-400">
                            {row.productIds.length} product(s)
                          </span>
                        )}
                        {row.scope === 'CATEGORY' && (
                          <span className="block text-[11px] text-gray-400">
                            {row.categoryIds.length} category(ies)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-semibold text-ink-900">{discountLabel(row)}</p>
                        {row.minOrderPaise > 0 && (
                          <p className="text-[11px] text-gray-400">
                            Min {formatPaise(row.minOrderPaise)}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                        {fmtDate(row.startAt)}
                        <span className="block text-[11px]">– {fmtDate(row.endAt)}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="text-ink-900">
                          {row.usedCount}
                          <span className="text-gray-400"> / {row.usageLimit ?? '∞'}</span>
                        </p>
                        {usagePercent !== null && (
                          <div className="mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-cream-100">
                            <div
                              className="h-full rounded-full bg-brand-600"
                              style={{ width: `${usagePercent}%` }}
                            />
                          </div>
                        )}
                        <p className="text-[11px] text-gray-400">{row.orderCount} orders</p>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <p className="font-semibold text-ink-900">
                          {formatPaise(row.salesGeneratedPaise)}
                        </p>
                        <p className="text-[11px] text-gray-400">
                          −{formatPaise(row.discountGivenPaise)}
                          {row.roi != null && ` · ${row.roi.toFixed(1)}×`}
                        </p>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLES[row.status]}`}
                        >
                          {PROMOTION_STATUS_LABELS[row.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setEditing(row)}
                            title="Edit"
                            className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50"
                          >
                            ✎
                          </button>
                          {row.status === 'RUNNING' || row.status === 'SCHEDULED' ? (
                            <button
                              onClick={() => void setState(row, 'PAUSED')}
                              disabled={busyId === row.id}
                              title="Pause"
                              className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50 disabled:opacity-40"
                            >
                              ⏸
                            </button>
                          ) : row.status === 'PAUSED' || row.status === 'DRAFT' ? (
                            <button
                              onClick={() => void setState(row, 'ACTIVE')}
                              disabled={busyId === row.id}
                              title="Activate"
                              className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50 disabled:opacity-40"
                            >
                              ▶
                            </button>
                          ) : null}
                          <button
                            onClick={() => void remove(row)}
                            disabled={busyId === row.id}
                            title={row.usedCount > 0 ? 'End promotion' : 'Delete'}
                            className="rounded-lg border border-gray-300 px-2 py-1 text-red-600 hover:bg-red-50 disabled:opacity-40"
                          >
                            🗑
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-12 text-center text-gray-500">
                      No promotions here yet.{' '}
                      <button
                        onClick={() => setCreating(true)}
                        className="font-semibold text-brand-600"
                      >
                        Create your first one →
                      </button>
                    </td>
                  </tr>
                )}
                {!data && (
                  <tr>
                    <td colSpan={8} className="px-3 py-12 text-center text-gray-400">
                      Loading…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {data && data.total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-3 py-2.5 text-xs">
                <p className="text-gray-500">
                  Showing {(data.page - 1) * data.pageSize + 1}–
                  {Math.min(data.page * data.pageSize, data.total)} of {data.total} promotions
                </p>
                <div className="flex items-center gap-2">
                  <button
                    disabled={data.page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold disabled:opacity-40"
                  >
                    ‹
                  </button>
                  <span className="text-gray-600">
                    Page {data.page} / {data.totalPages}
                  </span>
                  <button
                    disabled={data.page >= data.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold disabled:opacity-40"
                  >
                    ›
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* --- Sidebar --------------------------------------------------- */}
        <div className="space-y-4">
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Promotion performance</h2>
            <p className="text-[11px] text-gray-400">Sales generated, by what the offer targeted</p>
            {summary && summary.performance.length > 0 ? (
              <div className="mt-3">
                <DonutChart
                  slices={summary.performance.map((p) => ({
                    key: p.key,
                    label: p.label,
                    count: Math.round(p.amountPaise / 100),
                    share: p.share,
                  }))}
                  total={Math.round((k?.salesFromPromotionsPaise ?? 0) / 100)}
                  totalLabel="SALES ₹"
                  size={120}
                />
              </div>
            ) : (
              <p className="mt-3 text-xs text-gray-400">
                No redemptions yet — sales appear here once shoppers use an offer.
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Top performing promotions</h2>
            {summary && summary.topPromotions.length > 0 ? (
              <ul className="mt-3 space-y-2.5 text-xs">
                {summary.topPromotions.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink-900">{p.name}</p>
                      <p className="text-[11px] text-gray-400">
                        {p.code ? `Code ${p.code} · ` : ''}
                        {p.orderCount} orders
                      </p>
                    </div>
                    <span className="font-semibold text-ink-900">{formatPaise(p.salesPaise)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-400">Nothing has been redeemed yet.</p>
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Promotion tips</h2>
            <ul className="mt-2 space-y-2 text-[11px] text-gray-500">
              {TIPS.map((tip) => (
                <li key={tip} className="flex gap-2">
                  <span className="text-brand-600">✦</span>
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-gray-100 bg-cream-50 p-4">
            <h2 className="text-sm font-bold text-ink-900">How the money works</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-600">
              A promotion lowers the price on your lines at checkout. Your payout is calculated on
              the discounted amount, so the saving comes out of your margin — not the
              marketplace&apos;s commission.
            </p>
            <Link
              href="/seller/payouts"
              className="mt-2 inline-block text-[11px] font-semibold text-brand-600 hover:underline"
            >
              See it in your payouts →
            </Link>
          </section>
        </div>
      </div>

      {(creating || editing) && (
        <PromotionModal
          initial={editing ?? undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            void loadList();
            void loadSummary();
            setNotice('Promotion saved.');
          }}
        />
      )}
    </div>
  );
}
