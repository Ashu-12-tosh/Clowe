'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CUSTOMER_SEGMENTS,
  CUSTOMER_SEGMENT_LABELS,
  CUSTOMER_SEGMENT_RULES,
  CUSTOMER_SORTS,
  CUSTOMER_SORT_LABELS,
  CUSTOMER_STATUSES,
  CUSTOMER_STATUS_LABELS,
  type CustomerSegment,
  type CustomerSort,
  type CustomerStatus,
  type SellerCustomerPage,
  type SellerCustomerSummary,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { DonutChart } from '@/components/charts/Charts';
import CustomerDrawer, {
  CUSTOMER_STATUS_STYLES,
  SEGMENT_STYLES,
} from '@/components/seller/CustomerDrawer';

function num(n: number): string {
  return n.toLocaleString('en-IN');
}

function Delta({ change, invert = false }: { change: number | null; invert?: boolean }) {
  if (change === null) return <span className="text-gray-400">no prior month</span>;
  const good = invert ? change <= 0 : change >= 0;
  return (
    <span className={good ? 'text-green-600' : 'text-red-600'}>
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

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
      <h2 className="text-sm font-bold text-ink-900">{title}</h2>
      {subtitle && <p className="text-[11px] text-gray-400">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Horizontal share bar used by the segment / frequency / city panels. */
function ShareBar({
  label,
  count,
  share,
  onClick,
}: {
  label: string;
  count: number;
  share: number;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-700">{label}</span>
        <span className="font-semibold text-ink-900">
          {num(count)} <span className="font-normal text-gray-400">({share}%)</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
        <div className="h-full rounded-full bg-brand-600" style={{ width: `${share}%` }} />
      </div>
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="w-full text-left hover:opacity-80">
      {body}
    </button>
  ) : (
    <div>{body}</div>
  );
}

export default function SellerCustomersPage() {
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState<'ALL' | CustomerSegment>('ALL');
  const [status, setStatus] = useState<'ALL' | CustomerStatus>('ALL');
  const [city, setCity] = useState('');
  const [sort, setSort] = useState<CustomerSort>('LTV_HIGH');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [data, setData] = useState<SellerCustomerPage | null>(null);
  const [summary, setSummary] = useState<SellerCustomerSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const query = useMemo(() => {
    const p = new URLSearchParams({ sort });
    if (q.trim()) p.set('q', q.trim());
    if (segment !== 'ALL') p.set('segment', segment);
    if (status !== 'ALL') p.set('status', status);
    if (city) p.set('city', city);
    return p.toString();
  }, [q, segment, status, city, sort]);

  const loadList = useCallback(async () => {
    try {
      setData(
        await api<SellerCustomerPage>(
          `/api/seller/customers?${query}&page=${page}&pageSize=${pageSize}`,
          { auth: true },
        ),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load customers');
      setData(null);
    }
  }, [query, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<SellerCustomerSummary>('/api/seller/customers/summary', { auth: true }));
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
  useEffect(() => setPage(1), [query, pageSize]);

  const k = summary?.kpis;

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Customer Management</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Everyone who has bought from your shop, with the numbers that matter for keeping them.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              void downloadFile(
                `/api/seller/customers/export?${query}`,
                'clowe-customers.csv',
              ).catch(() => setError('Export failed'))
            }
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            ⬇ Export
          </button>
          <Link
            href="/seller/promotions"
            className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700"
          >
            🏷 Run a promotion
          </Link>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* --- KPIs -------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {k ? (
          <>
            <KpiCard
              icon="👥"
              label="Total customers"
              value={num(k.total)}
              footer="Shoppers who bought from you"
            />
            <KpiCard
              icon="✨"
              label="New this month"
              value={num(k.newThisMonth)}
              footer={<Delta change={k.newChangePercent} />}
            />
            <KpiCard
              icon="🔁"
              label="Repeat customers"
              value={num(k.repeat)}
              footer={`${k.repeatRate}% buy more than once`}
            />
            <KpiCard
              icon="₹"
              label="Avg lifetime value"
              value={formatPaise(k.avgLtvPaise)}
              footer="Spend per customer with you"
            />
            <KpiCard
              icon="📦"
              label="Total orders"
              value={num(k.orders)}
              footer="Across all your customers"
            />
            <KpiCard
              icon="↩"
              label="Return rate"
              value={`${k.returnRate}%`}
              footer="Units sent back"
            />
          </>
        ) : (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <div className="xl:col-span-3">
          {/* --- Filters ------------------------------------------------- */}
          <div className="flex flex-wrap items-center gap-2 rounded-t-2xl border border-b-0 border-gray-100 bg-white p-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or city…"
              className="min-w-56 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
            />
            <select
              value={segment}
              onChange={(e) => setSegment(e.target.value as 'ALL' | CustomerSegment)}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
            >
              <option value="ALL">All segments</option>
              {CUSTOMER_SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {CUSTOMER_SEGMENT_LABELS[s]}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as 'ALL' | CustomerStatus)}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
            >
              <option value="ALL">All statuses</option>
              {CUSTOMER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {CUSTOMER_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <select
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="max-w-36 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
            >
              <option value="">All cities</option>
              {summary?.topCities.map((c) => (
                <option key={c.city} value={c.city}>
                  {c.city}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as CustomerSort)}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
            >
              {CUSTOMER_SORTS.map((s) => (
                <option key={s} value={s}>
                  {CUSTOMER_SORT_LABELS[s]}
                </option>
              ))}
            </select>
            {(q || segment !== 'ALL' || status !== 'ALL' || city) && (
              <button
                onClick={() => {
                  setQ('');
                  setSegment('ALL');
                  setStatus('ALL');
                  setCity('');
                }}
                className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-gray-50"
              >
                Reset
              </button>
            )}
          </div>

          {/* --- Table --------------------------------------------------- */}
          <div className="overflow-x-auto rounded-b-2xl border border-gray-100 bg-white">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-left uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2.5 font-semibold">Customer</th>
                  <th className="px-3 py-2.5 font-semibold">Segment</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Orders</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Lifetime value</th>
                  <th className="px-3 py-2.5 font-semibold">Last order</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((row) => (
                  <tr key={row.userId} className="border-t border-gray-100 hover:bg-cream-50">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cream-100 text-[11px] font-bold text-ink-900">
                          {row.name.slice(0, 2).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="max-w-40 truncate font-medium text-ink-900">{row.name}</p>
                          <p className="text-[11px] text-gray-400">
                            {row.city ?? '—'}
                            {row.state ? `, ${row.state}` : ''}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${SEGMENT_STYLES[row.segment]}`}
                        title={CUSTOMER_SEGMENT_RULES[row.segment]}
                      >
                        {row.segmentLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <p className="font-semibold text-ink-900">{row.orderCount}</p>
                      <p className="text-[11px] text-gray-400">{row.unitsBought} units</p>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <p className="font-semibold text-ink-900">{formatPaise(row.ltvPaise)}</p>
                      <p className="text-[11px] text-gray-400">
                        {formatPaise(row.avgOrderValuePaise)} avg
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                      {new Date(row.lastOrderAt).toLocaleDateString('en-IN')}
                      <span className="block text-[11px] text-gray-400">
                        {row.daysSinceLastOrder}d ago
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${CUSTOMER_STATUS_STYLES[row.status]}`}
                      >
                        {row.statusLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => setOpenId(row.userId)}
                        title="View customer"
                        className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold hover:bg-gray-50"
                      >
                        👁 View
                      </button>
                    </td>
                  </tr>
                ))}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-12 text-center text-gray-500">
                      No customers match these filters.
                    </td>
                  </tr>
                )}
                {!data && (
                  <tr>
                    <td colSpan={7} className="px-3 py-12 text-center text-gray-400">
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
                  {Math.min(data.page * data.pageSize, data.total)} of {data.total} customers
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
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1 outline-none"
                  >
                    {[10, 25, 50].map((n) => (
                      <option key={n} value={n}>
                        {n} / page
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* --- Analysis panels ---------------------------------------- */}
          {summary && (
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <Panel title="Customer segments" subtitle="Click a segment to filter the table">
                <ul className="space-y-2.5">
                  {summary.segments.map((s) => (
                    <li key={s.key} title={s.rule}>
                      <ShareBar
                        label={s.label}
                        count={s.count}
                        share={s.share}
                        onClick={() => setSegment(s.key)}
                      />
                    </li>
                  ))}
                  {summary.segments.length === 0 && (
                    <li className="text-xs text-gray-400">No customers yet.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="Purchase frequency" subtitle="Orders placed with your shop">
                <ul className="space-y-2.5">
                  {summary.frequency.map((f) => (
                    <li key={f.key}>
                      <ShareBar label={f.label} count={f.count} share={f.share} />
                    </li>
                  ))}
                  {summary.frequency.length === 0 && (
                    <li className="text-xs text-gray-400">No orders yet.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="Top cities" subtitle="Where your customers are">
                <ul className="space-y-2.5">
                  {summary.topCities.map((c) => (
                    <li key={c.city}>
                      <ShareBar
                        label={c.city}
                        count={c.count}
                        share={c.share}
                        onClick={() => setCity(c.city)}
                      />
                    </li>
                  ))}
                  {summary.topCities.length === 0 && (
                    <li className="text-xs text-gray-400">No delivery cities yet.</li>
                  )}
                </ul>
              </Panel>
            </div>
          )}
        </div>

        {/* --- Sidebar --------------------------------------------------- */}
        <div className="space-y-4">
          {summary && (
            <>
              <Panel title="Customer overview">
                {summary.segments.length > 0 ? (
                  <DonutChart
                    slices={summary.segments.map((s) => ({
                      key: s.key,
                      label: s.label,
                      count: s.count,
                      share: s.share,
                    }))}
                    total={summary.kpis.total}
                    totalLabel="CUSTOMERS"
                    size={120}
                  />
                ) : (
                  <p className="text-xs text-gray-400">No customers yet.</p>
                )}
              </Panel>

              <Panel title="Top customers" subtitle="By lifetime value with your shop">
                <ul className="space-y-2.5 text-xs">
                  {summary.topCustomers.map((c, i) => (
                    <li key={c.userId}>
                      <button
                        onClick={() => setOpenId(c.userId)}
                        className="flex w-full items-center gap-2.5 text-left hover:text-brand-600"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-100 text-[10px] font-bold text-gray-500">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink-900">{c.name}</span>
                          <span className="text-[11px] text-gray-400">{c.orderCount} orders</span>
                        </span>
                        <span className="font-semibold text-ink-900">
                          {formatPaise(c.ltvPaise)}
                        </span>
                      </button>
                    </li>
                  ))}
                  {summary.topCustomers.length === 0 && (
                    <li className="text-gray-400">No customers yet.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="Customer insights">
                <ul className="space-y-2.5 text-xs">
                  {summary.insights.map((insight) => (
                    <li key={insight.key} className="flex gap-2">
                      <span>
                        {insight.tone === 'GOOD' ? '✅' : insight.tone === 'WARN' ? '⚠️' : 'ℹ️'}
                      </span>
                      <span>
                        <span className="font-semibold text-ink-900">{insight.title}</span>
                        <span className="block text-gray-500">{insight.body}</span>
                      </span>
                    </li>
                  ))}
                  {summary.insights.length === 0 && (
                    <li className="text-gray-400">Nothing to flag yet.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="How segments work">
                <ul className="space-y-1.5 text-[11px] text-gray-500">
                  {CUSTOMER_SEGMENTS.map((s) => (
                    <li key={s}>
                      <span className="font-semibold text-ink-900">
                        {CUSTOMER_SEGMENT_LABELS[s]}:
                      </span>{' '}
                      {CUSTOMER_SEGMENT_RULES[s]}
                    </li>
                  ))}
                </ul>
              </Panel>
            </>
          )}
          {!summary && <div className="h-64 animate-pulse rounded-2xl bg-gray-100" />}
        </div>
      </div>

      {openId && <CustomerDrawer userId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
