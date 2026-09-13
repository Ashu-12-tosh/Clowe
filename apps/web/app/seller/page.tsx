'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  HEALTH_GRADE_LABELS,
  SALES_GRANULARITIES,
  SALES_GRANULARITY_LABELS,
  SELLER_DASH_RANGES,
  SELLER_DASH_RANGE_LABELS,
  type HealthGrade,
  type HealthMetric,
  type SalesGranularity,
  type SellerDashRange,
  type SellerDashboard,
  type SellerMetric,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { DonutChart, MultiLineChart } from '@/components/charts/Charts';
import { useSeller } from '@/components/seller/SellerContext';
import ReferralCard from '@/components/seller/ReferralCard';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  DELIVERED: 'bg-green-100 text-green-700',
  CONFIRMED: 'bg-yellow-100 text-yellow-800',
  PACKED: 'bg-yellow-100 text-yellow-800',
  SHIPPED: 'bg-blue-100 text-blue-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-100 text-orange-700',
  RETURNED: 'bg-red-100 text-red-700',
};

const GRADE_STYLES: Record<HealthGrade, string> = {
  EXCELLENT: 'bg-green-100 text-green-700',
  GOOD: 'bg-green-50 text-green-600',
  FAIR: 'bg-yellow-100 text-yellow-800',
  POOR: 'bg-red-100 text-red-700',
};

function num(n: number): string {
  return n.toLocaleString('en-IN');
}

function shortMoney(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 10000000) return `₹${(rupees / 10000000).toFixed(1)}Cr`;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`;
  if (rupees >= 1000) return `₹${Math.round(rupees / 1000)}K`;
  return `₹${Math.round(rupees)}`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function Delta({ metric, label }: { metric: SellerMetric; label: string }) {
  if (metric.changePercent === null) {
    return <span className="text-gray-400">no {label} to compare</span>;
  }
  const up = metric.changePercent >= 0;
  return (
    <>
      <span className={up ? 'text-green-600' : 'text-red-600'}>
        {up ? '↑' : '↓'} {Math.abs(metric.changePercent)}%
      </span>{' '}
      <span className="text-gray-400">vs {label}</span>
    </>
  );
}

function KpiCard({
  icon,
  iconClass,
  label,
  value,
  hint,
}: {
  icon: string;
  iconClass: string;
  label: string;
  value: string;
  hint: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-gray-500">{label}</p>
          <p className="mt-1 truncate font-display text-xl font-bold text-ink-900">{value}</p>
        </div>
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base ${iconClass}`}
        >
          {icon}
        </span>
      </div>
      <p className="mt-2 truncate text-[11px]">{hint}</p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-gray-100 bg-white p-4 ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-ink-900">{title}</h2>
          {subtitle && <p className="text-[11px] text-gray-400">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function StatusBanner() {
  const { state } = useSeller();
  if (state.kind !== 'ready') return null;
  const { status, rejectionReason } = state.profile;
  if (status === 'APPROVED') return null;

  const styles: Record<string, string> = {
    PENDING: 'border-yellow-200 bg-yellow-50 text-yellow-800',
    REJECTED: 'border-red-200 bg-red-50 text-red-700',
    SUSPENDED: 'border-red-200 bg-red-50 text-red-700',
    BANNED: 'border-red-200 bg-red-50 text-red-700',
  };
  const messages: Record<string, string> = {
    PENDING:
      'Your seller application is under review. You can add products once the admin approves your account.',
    REJECTED: `Your application was rejected${rejectionReason ? `: ${rejectionReason}` : '.'}`,
    SUSPENDED: 'Your seller account is suspended. Contact support.',
    BANNED: 'Your seller account has been closed. Contact support.',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${styles[status] ?? styles.PENDING}`}>
      <span className="font-semibold">{status}</span> — {messages[status] ?? messages.PENDING}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SellerDashboardPage() {
  const [range, setRange] = useState<SellerDashRange>('MONTH');
  const [granularity, setGranularity] = useState<SalesGranularity>('DAILY');
  const [data, setData] = useState<SellerDashboard | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(
        await api<SellerDashboard>(
          `/api/seller/dashboard?range=${range}&granularity=${granularity}`,
          { auth: true },
        ),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load your dashboard.');
    }
  }, [range, granularity]);

  useEffect(() => {
    void load();
  }, [load]);

  const k = data?.kpis;
  const rangeLabel = data ? SELLER_DASH_RANGE_LABELS[data.range.key].toLowerCase() : '';
  const previousLabel = useMemo(() => {
    switch (range) {
      case 'TODAY':
        return 'yesterday';
      case 'WEEK':
        return 'previous 7 days';
      case 'QUARTER':
        return 'previous 90 days';
      case 'YEAR':
        return 'last year';
      default:
        return 'last month';
    }
  }, [range]);

  return (
    <div className="pb-10">
      {/* Header ------------------------------------------------------------ */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">
            Welcome back, {data?.store.shopName ?? 'seller'} 👋
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Here&apos;s what&apos;s happening with your store today.
            {data && <span className="ml-1 text-gray-400">Seller ID {data.store.sellerCode}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as SellerDashRange)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold outline-none focus:border-brand-600"
          >
            {SELLER_DASH_RANGES.map((r) => (
              <option key={r} value={r}>
                {SELLER_DASH_RANGE_LABELS[r]}
              </option>
            ))}
          </select>
          {data?.store.slug && (
            <Link
              href={`/store/${data.store.slug}`}
              className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              ↗ Visit own store
            </Link>
          )}
        </div>
      </div>

      <div className="mt-4">
        <StatusBanner />
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Things to do today ------------------------------------------------ */}
      {data && data.actions.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {data.actions.map((a) => (
            <Link
              key={a.key}
              href={a.href}
              className={`rounded-lg border px-3.5 py-2 text-xs font-medium ${
                a.tone === 'WARN'
                  ? 'border-yellow-300 bg-yellow-50 text-yellow-800 hover:bg-yellow-100'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {a.count} {a.label}
            </Link>
          ))}
        </div>
      )}

      {/* KPIs -------------------------------------------------------------- */}
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {k && data ? (
          <>
            <KpiCard
              icon="₹"
              iconClass="bg-yellow-50 text-yellow-700"
              label="Total sales"
              value={formatPaise(k.salesPaise.value)}
              hint={<Delta metric={k.salesPaise} label={previousLabel} />}
            />
            <KpiCard
              icon="🛍"
              iconClass="bg-green-50 text-green-700"
              label="Orders"
              value={num(k.orders.value)}
              hint={<Delta metric={k.orders} label={previousLabel} />}
            />
            <KpiCard
              icon="📦"
              iconClass="bg-blue-50 text-blue-700"
              label="Units sold"
              value={num(k.unitsSold.value)}
              hint={<Delta metric={k.unitsSold} label={previousLabel} />}
            />
            <KpiCard
              icon="💳"
              iconClass="bg-purple-50 text-purple-700"
              label="Your earnings"
              value={formatPaise(k.netRevenuePaise.value)}
              hint={<span className="text-gray-400">after commission, gateway &amp; TDS</span>}
            />
            <KpiCard
              icon="⏱"
              iconClass="bg-orange-50 text-orange-700"
              label="Pending orders"
              value={num(k.pendingOrders)}
              hint={
                k.pendingOrders > 0 ? (
                  <Link href="/seller/orders" className="font-semibold text-orange-600">
                    View and ship now
                  </Link>
                ) : (
                  <span className="text-gray-400">nothing waiting</span>
                )
              }
            />
            <KpiCard
              icon="★"
              iconClass="bg-cream-100 text-brand-600"
              label="Store rating"
              value={k.rating.average === null ? '—' : `${k.rating.average} ★`}
              hint={
                k.rating.count === 0 ? (
                  <span className="text-gray-400">no reviews yet</span>
                ) : k.rating.changeVsPrevious !== null && k.rating.changeVsPrevious !== 0 ? (
                  <>
                    <span
                      className={k.rating.changeVsPrevious > 0 ? 'text-green-600' : 'text-red-600'}
                    >
                      {k.rating.changeVsPrevious > 0 ? '↑' : '↓'}{' '}
                      {Math.abs(k.rating.changeVsPrevious)}
                    </span>{' '}
                    <span className="text-gray-400">from {num(k.rating.count)} reviews</span>
                  </>
                ) : (
                  <span className="text-gray-400">from {num(k.rating.count)} reviews</span>
                )
              }
            />
          </>
        ) : (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      {data && (
        <>
          {/* Sales / status / categories --------------------------------- */}
          <div className="mt-4 grid gap-4 xl:grid-cols-4">
            <div className="xl:col-span-2">
              <Panel
                title="Sales overview"
                subtitle={`Sales and orders · ${rangeLabel}`}
                action={
                  <select
                    value={granularity}
                    onChange={(e) => setGranularity(e.target.value as SalesGranularity)}
                    className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                  >
                    {SALES_GRANULARITIES.map((g) => (
                      <option key={g} value={g}>
                        {SALES_GRANULARITY_LABELS[g]}
                      </option>
                    ))}
                  </select>
                }
              >
                <MultiLineChart
                  height={200}
                  format={shortMoney}
                  series={[
                    {
                      key: 'sales',
                      label: 'Sales (₹)',
                      color: '#B8860B',
                      fill: true,
                      points: data.salesTrend.map((t) => ({
                        date: t.date,
                        value: t.salesPaise,
                      })),
                    },
                  ]}
                />
                <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                  Orders
                </p>
                <MultiLineChart
                  height={90}
                  format={(v) => num(v)}
                  series={[
                    {
                      key: 'orders',
                      label: 'Orders',
                      color: '#64748B',
                      points: data.salesTrend.map((t) => ({ date: t.date, value: t.orders })),
                    },
                  ]}
                />
              </Panel>
            </div>

            <Panel title="Order status" subtitle={`Your lines · ${rangeLabel}`}>
              {data.orderStatus.length > 0 ? (
                <DonutChart
                  slices={data.orderStatus}
                  total={data.orderStatus.reduce((sum, s) => sum + s.count, 0)}
                  totalLabel="TOTAL"
                  size={130}
                />
              ) : (
                <p className="text-xs text-gray-400">No orders in this period.</p>
              )}
            </Panel>

            <Panel
              title="Top selling categories"
              subtitle="By units sold"
              action={
                <Link href="/seller/products" className="text-[11px] font-semibold text-brand-600">
                  View report →
                </Link>
              }
            >
              <ul className="space-y-2.5 text-xs">
                {data.topCategories.map((c) => (
                  <li key={c.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-gray-700">{c.name}</span>
                      <span className="shrink-0 font-semibold text-ink-900">{c.share}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                      <div
                        className="h-full rounded-full bg-brand-600"
                        style={{ width: `${Math.max(c.share, 2)}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {num(c.unitsSold)} units · {formatPaise(c.salesPaise)}
                    </p>
                  </li>
                ))}
                {data.topCategories.length === 0 && (
                  <li className="text-gray-400">No sales in this period.</li>
                )}
              </ul>
            </Panel>
          </div>

          {/* Orders / products / payout + health -------------------------- */}
          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            <Panel
              title="Recent orders"
              action={
                <Link href="/seller/orders" className="text-[11px] font-semibold text-brand-600">
                  View all orders →
                </Link>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase tracking-wide text-gray-500">
                      <th className="pb-2 font-semibold">Order</th>
                      <th className="pb-2 font-semibold">Customer</th>
                      <th className="pb-2 text-right font-semibold">Amount</th>
                      <th className="pb-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentOrders.map((o) => (
                      <tr key={o.id} className="border-t border-gray-100">
                        <td className="py-2">
                          <p className="font-mono text-brand-600">{o.orderNumber}</p>
                          <p className="text-[11px] text-gray-400">{when(o.createdAt)}</p>
                        </td>
                        <td className="max-w-28 truncate py-2 text-ink-900">{o.customerName}</td>
                        <td className="py-2 text-right font-semibold text-ink-900">
                          {formatPaise(o.amountPaise)}
                        </td>
                        <td className="py-2">
                          <span
                            className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              STATUS_STYLES[o.status] ?? 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {o.statusLabel}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {data.recentOrders.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-gray-500">
                          No orders yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel
              title="Product performance"
              subtitle={`Best sellers · ${rangeLabel}`}
              action={
                <Link href="/seller/products" className="text-[11px] font-semibold text-brand-600">
                  View report →
                </Link>
              }
            >
              <ul className="space-y-2.5 text-xs">
                {data.productPerformance.map((p) => (
                  <li key={p.id} className="flex items-center gap-2">
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.imageUrl}
                        alt=""
                        className="h-9 w-8 shrink-0 rounded border border-gray-200 object-cover"
                      />
                    ) : (
                      <div className="h-9 w-8 shrink-0 rounded bg-gray-100" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ink-900">{p.title}</p>
                      <p className="text-[11px] text-gray-400">{num(p.unitsSold)} units sold</p>
                    </div>
                    <span className="shrink-0 font-semibold text-ink-900">
                      {formatPaise(p.salesPaise)}
                    </span>
                  </li>
                ))}
                {data.productPerformance.length === 0 && (
                  <li className="text-gray-400">Nothing sold in this period.</li>
                )}
              </ul>
            </Panel>

            <div className="space-y-4">
              <Panel
                title="Payout summary"
                action={
                  <Link href="/seller/payouts" className="text-[11px] font-semibold text-brand-600">
                    View payouts →
                  </Link>
                }
              >
                <dl className="space-y-2 text-xs">
                  {[
                    ['Paid out to date', formatPaise(data.payouts.lifetimePaidPaise)],
                    ['Settled this month', formatPaise(data.payouts.thisMonthPaise)],
                    ['Ready to withdraw', formatPaise(data.payouts.availablePaise)],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-2">
                      <dt className="text-gray-500">{label}</dt>
                      <dd className="font-semibold text-ink-900">{value}</dd>
                    </div>
                  ))}
                  {data.payouts.inClearingPaise > 0 && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-gray-500">Still clearing</dt>
                      <dd className="text-gray-600">
                        {formatPaise(data.payouts.inClearingPaise)}
                        {data.payouts.nextClearingAt && (
                          <span className="block text-[11px] text-gray-400">
                            frees up {when(data.payouts.nextClearingAt)}
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                </dl>

                <Link
                  href="/seller/payouts"
                  aria-disabled={!data.payouts.canWithdraw}
                  className={`mt-3 block rounded-lg py-2 text-center text-xs font-bold ${
                    data.payouts.canWithdraw
                      ? 'bg-brand-600 text-white hover:bg-brand-700'
                      : 'pointer-events-none bg-gray-100 text-gray-400'
                  }`}
                >
                  Withdraw earnings
                </Link>
                {data.payouts.blockedReason && (
                  <p className="mt-1.5 text-center text-[11px] text-gray-400">
                    {data.payouts.blockedReason}
                  </p>
                )}
              </Panel>

              <Panel
                title="Store health"
                subtitle={
                  data.health.scorePercent === null
                    ? 'Not enough orders to grade yet'
                    : `Score ${data.health.scorePercent}/100 · all time`
                }
              >
                <ul className="space-y-2.5">
                  {data.health.metrics.map((m) => (
                    <HealthRow key={m.key} metric={m} />
                  ))}
                </ul>
              </Panel>
            </div>
          </div>

          {/* Growth ------------------------------------------------------- */}
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-brand-200 bg-cream-50 p-5">
                <div className="min-w-0">
                  <h2 className="font-display text-lg font-bold text-ink-900">
                    Grow your business with Clowe
                  </h2>
                  <p className="mt-0.5 text-sm text-gray-600">
                    Run ads, offer discounts and reach more shoppers.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link
                    href="/seller/ads/new"
                    className="rounded-lg border border-brand-600 px-4 py-2 text-xs font-bold text-brand-600 hover:bg-white"
                  >
                    Create campaign
                  </Link>
                  <Link
                    href="/seller/promotions"
                    className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold text-white hover:bg-brand-700"
                  >
                    Create promotion
                  </Link>
                </div>
              </section>
            </div>
            <ReferralCard />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Store health row
// ---------------------------------------------------------------------------

function HealthRow({ metric }: { metric: HealthMetric }) {
  const [open, setOpen] = useState(false);

  return (
    <li>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left text-xs"
      >
        <span className="min-w-0 truncate text-gray-600">{metric.label}</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="font-semibold text-ink-900">
            {metric.measurable ? `${metric.percent}%` : '—'}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${GRADE_STYLES[metric.grade]}`}
          >
            {metric.measurable ? HEALTH_GRADE_LABELS[metric.grade] : 'No data'}
          </span>
        </span>
      </button>
      <p className="mt-0.5 text-[11px] text-gray-400">{metric.basis}</p>

      {open && (
        <div className="mt-1.5 rounded-lg bg-cream-50 px-2.5 py-2 text-[11px] text-gray-600">
          <p className="font-semibold text-ink-900">
            {metric.lowerIsBetter ? 'Lower is better' : 'Higher is better'}
          </p>
          <ul className="mt-1 space-y-0.5">
            {metric.bands.map((b, i) => {
              const previous = metric.bands[i - 1]?.upTo;
              const text = metric.lowerIsBetter
                ? previous === undefined
                  ? `up to ${b.upTo}%`
                  : `${previous}% – ${b.upTo}%`
                : `${b.upTo}% and above`;
              return (
                <li key={b.grade} className="flex justify-between gap-2">
                  <span>{HEALTH_GRADE_LABELS[b.grade]}</span>
                  <span className="text-gray-400">{text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}
