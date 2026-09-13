'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  OVERVIEW_RANGES,
  OVERVIEW_RANGE_LABELS,
  type AdminOverview,
  type OverviewMetric,
  type OverviewRange,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { DonutChart, LineChart } from '@/components/charts/Charts';

const STATUS_STYLES: Record<string, string> = {
  DELIVERED: 'bg-green-100 text-green-700',
  SHIPPED: 'bg-purple-100 text-purple-700',
  PACKED: 'bg-indigo-100 text-indigo-700',
  CONFIRMED: 'bg-blue-100 text-blue-700',
  PLACED: 'bg-yellow-100 text-yellow-800',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-100 text-orange-700',
  RETURNED: 'bg-red-100 text-red-700',
};

const HEALTH_STYLES: Record<string, string> = {
  OPERATIONAL: 'text-green-600',
  SANDBOX: 'text-yellow-600',
  DEGRADED: 'text-yellow-600',
  DOWN: 'text-red-600',
};

const HEALTH_LABELS: Record<string, string> = {
  OPERATIONAL: 'Operational',
  SANDBOX: 'Sandbox',
  DEGRADED: 'Degraded',
  DOWN: 'Down',
};

function num(n: number): string {
  return n.toLocaleString('en-IN');
}

/** Compact money for chart axes, where a full ₹12,45,600 would not fit. */
function shortMoney(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 10000000) return `₹${(rupees / 10000000).toFixed(1)}Cr`;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`;
  if (rupees >= 1000) return `₹${Math.round(rupees / 1000)}K`;
  return `₹${Math.round(rupees)}`;
}

function Delta({ metric }: { metric: OverviewMetric }) {
  if (metric.changePercent === null) {
    return <span className="text-gray-400">no prior period</span>;
  }
  const up = metric.changePercent >= 0;
  return (
    <span className={up ? 'text-green-600' : 'text-red-600'}>
      {up ? '↑' : '↓'} {Math.abs(metric.changePercent)}%{' '}
      <span className="text-gray-400">vs previous</span>
    </span>
  );
}

function KpiCard({
  icon,
  label,
  value,
  metric,
}: {
  icon: string;
  label: string;
  value: string;
  metric: OverviewMetric;
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
      <p className="mt-2 text-[11px]">
        <Delta metric={metric} />
      </p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
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

export default function AdminDashboardPage() {
  const [range, setRange] = useState<OverviewRange>('MONTH');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<AdminOverview>(`/api/admin/overview?range=${range}`, { auth: true }));
      setError('');
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'Could not load the dashboard (are you signed in as admin?)',
      );
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const kpis = data?.kpis;

  return (
    <div className="pb-10">
      {/* Header ------------------------------------------------------------ */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Dashboard Overview</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Marketplace performance, computed live from orders, sellers and support.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as OverviewRange)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold outline-none focus:border-brand-600"
          >
            {OVERVIEW_RANGES.map((r) => (
              <option key={r} value={r}>
                {OVERVIEW_RANGE_LABELS[r]}
              </option>
            ))}
          </select>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Queues waiting on an admin ---------------------------------------- */}
      {data && (
        <div className="mt-4 flex flex-wrap gap-2">
          {[
            {
              n: data.pending.sellers,
              one: 'seller application',
              many: 'seller applications',
              href: '/admin/sellers?status=PENDING',
              icon: '🏪',
            },
            {
              n: data.pending.products,
              one: 'product awaiting review',
              many: 'products awaiting review',
              href: '/admin/products',
              icon: '👕',
            },
            {
              n: data.pending.tickets,
              one: 'open support ticket',
              many: 'open support tickets',
              href: '/admin/support',
              icon: '📮',
            },
            {
              n: data.pending.returns,
              one: 'return awaiting action',
              many: 'returns awaiting action',
              href: '/admin/returns',
              icon: '↩',
            },
            {
              n: data.pending.payouts,
              one: 'payout in flight',
              many: 'payouts in flight',
              href: '/admin/sellers',
              icon: '₹',
            },
          ]
            .filter((item) => item.n > 0)
            .map((item) => (
              <Link
                key={item.one}
                href={item.href}
                className="rounded-lg border border-yellow-300 bg-yellow-50 px-3.5 py-2 text-xs font-medium text-yellow-800 hover:bg-yellow-100"
              >
                {item.icon} {item.n} {item.n === 1 ? item.one : item.many}
              </Link>
            ))}
        </div>
      )}

      {/* KPIs -------------------------------------------------------------- */}
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {kpis ? (
          <>
            <KpiCard
              icon="💰"
              label="Total GMV"
              value={formatPaise(kpis.gmvPaise.value)}
              metric={kpis.gmvPaise}
            />
            <KpiCard icon="📦" label="Orders" value={num(kpis.orders.value)} metric={kpis.orders} />
            <KpiCard
              icon="👥"
              label="New users"
              value={num(kpis.users.value)}
              metric={kpis.users}
            />
            <KpiCard
              icon="🏪"
              label="Active sellers"
              value={num(kpis.activeSellers.value)}
              metric={kpis.activeSellers}
            />
            <KpiCard
              icon="👕"
              label="New products"
              value={num(kpis.products.value)}
              metric={kpis.products}
            />
            <KpiCard
              icon="📈"
              label="Platform revenue"
              value={formatPaise(kpis.revenuePaise.value)}
              metric={kpis.revenuePaise}
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
          {/* Sales / status / categories ------------------------------------ */}
          <div className="mt-4 grid gap-4 xl:grid-cols-4">
            <div className="xl:col-span-2">
              <Panel
                title="Sales overview"
                subtitle={`Delivered & paid GMV · ${OVERVIEW_RANGE_LABELS[data.range.key]}`}
              >
                <LineChart
                  points={data.salesTrend.map((t) => ({ date: t.date, value: t.gmvPaise }))}
                  format={shortMoney}
                  height={150}
                />
                <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                  Orders per day
                </p>
                <LineChart
                  points={data.salesTrend.map((t) => ({ date: t.date, value: t.orders }))}
                  color="#141414"
                  height={90}
                />
              </Panel>
            </div>

            <Panel title="Order status" subtitle="Every order on the platform">
              <DonutChart
                slices={data.orderStatus}
                total={data.orderStatus.reduce((sum, s) => sum + s.count, 0)}
                totalLabel="ORDERS"
                size={120}
              />
            </Panel>

            <Panel
              title="Top categories"
              subtitle={`By GMV · ${OVERVIEW_RANGE_LABELS[data.range.key]}`}
              action={
                <Link href="/admin/categories" className="text-[11px] font-semibold text-brand-600">
                  View all →
                </Link>
              }
            >
              <ul className="space-y-2 text-xs">
                {data.topCategories.map((c, i) => (
                  <li key={c.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-gray-700">
                        {i + 1}. {c.name}
                      </span>
                      <span className="shrink-0 font-semibold text-ink-900">
                        {formatPaise(c.gmvPaise)}{' '}
                        <span className="font-normal text-gray-400">({c.share}%)</span>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                      <div
                        className="h-full rounded-full bg-brand-600"
                        style={{ width: `${Math.max(c.share, 2)}%` }}
                      />
                    </div>
                  </li>
                ))}
                {data.topCategories.length === 0 && (
                  <li className="text-gray-400">No sales in this range.</li>
                )}
              </ul>
            </Panel>
          </div>

          {/* Recent orders / health / risk ---------------------------------- */}
          <div className="mt-4 grid gap-4 xl:grid-cols-4">
            <div className="xl:col-span-3">
              <section className="rounded-2xl border border-gray-100 bg-white">
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                  <h2 className="text-sm font-bold text-ink-900">Recent orders</h2>
                  <Link href="/admin/orders" className="text-[11px] font-semibold text-brand-600">
                    View all orders →
                  </Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-xs">
                    <thead>
                      <tr className="text-left uppercase tracking-wide text-gray-500">
                        <th className="px-4 py-2.5 font-semibold">Order</th>
                        <th className="px-4 py-2.5 font-semibold">Customer</th>
                        <th className="px-4 py-2.5 font-semibold">Seller</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
                        <th className="px-4 py-2.5 font-semibold">Payment</th>
                        <th className="px-4 py-2.5 font-semibold">Status</th>
                        <th className="px-4 py-2.5 font-semibold">Placed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentOrders.map((o) => (
                        <tr key={o.id} className="border-t border-gray-100 hover:bg-cream-50">
                          <td className="px-4 py-2.5 font-mono text-brand-600">{o.orderNumber}</td>
                          <td className="px-4 py-2.5 text-ink-900">{o.customerName}</td>
                          <td className="max-w-44 truncate px-4 py-2.5 text-gray-600">
                            {o.sellerNames.join(', ') || '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right font-semibold text-ink-900">
                            {formatPaise(o.amountPaise)}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                o.paymentStatus === 'PAID'
                                  ? 'bg-green-100 text-green-700'
                                  : o.paymentStatus === 'COD_PENDING'
                                    ? 'bg-yellow-100 text-yellow-800'
                                    : 'bg-gray-100 text-gray-600'
                              }`}
                            >
                              {o.paymentStatus === 'COD_PENDING'
                                ? 'COD'
                                : o.paymentStatus.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                STATUS_STYLES[o.status] ?? 'bg-gray-100 text-gray-600'
                              }`}
                            >
                              {o.status.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-gray-500">
                            {new Date(o.createdAt).toLocaleDateString('en-IN', {
                              day: 'numeric',
                              month: 'short',
                            })}
                          </td>
                        </tr>
                      ))}
                      {data.recentOrders.length === 0 && (
                        <tr>
                          <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                            No orders yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <div className="space-y-4">
              <Panel
                title="System health"
                action={
                  <span
                    className={`shrink-0 rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-semibold ${
                      HEALTH_STYLES[data.systemHealth.overall]
                    }`}
                  >
                    {data.systemHealth.overall === 'OPERATIONAL'
                      ? 'All systems go'
                      : data.systemHealth.overall === 'DEGRADED'
                        ? 'Degraded'
                        : 'Attention needed'}
                  </span>
                }
              >
                <ul className="space-y-1.5 text-xs">
                  {data.systemHealth.checks.map((c) => (
                    <li key={c.key} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-gray-700" title={c.detail}>
                        <span className={HEALTH_STYLES[c.status]}>●</span> {c.label}
                      </span>
                      <span className={`shrink-0 font-semibold ${HEALTH_STYLES[c.status]}`}>
                        {HEALTH_LABELS[c.status] ?? c.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel title="Fraud & risk alerts" subtitle="Each figure opens its queue">
                <ul className="space-y-2 text-xs">
                  {data.riskAlerts.map((a) => (
                    <li key={a.key}>
                      <Link
                        href={a.href}
                        className="flex items-center justify-between gap-2 hover:text-brand-600"
                        title={a.detail}
                      >
                        <span className="min-w-0 text-gray-700">{a.label}</span>
                        <span
                          className={`shrink-0 font-display text-base font-bold ${
                            a.count > 0 ? 'text-red-600' : 'text-gray-400'
                          }`}
                        >
                          {num(a.count)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel title="Quick actions">
                <div className="grid grid-cols-2 gap-2 text-[11px] font-semibold">
                  {[
                    ['Sellers', '/admin/sellers'],
                    ['Products', '/admin/products'],
                    ['Support', '/admin/support'],
                    ['Returns', '/admin/returns'],
                    ['Try-On', '/admin/tryon'],
                    ['Audit log', '/admin/audit'],
                  ].map(([label, href]) => (
                    <Link
                      key={href}
                      href={href}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-center text-gray-700 hover:border-brand-600 hover:text-brand-600"
                    >
                      {label}
                    </Link>
                  ))}
                </div>
              </Panel>
            </div>
          </div>

          {/* Sellers / try-on / summary ------------------------------------- */}
          <div className="mt-4 grid gap-4 xl:grid-cols-4">
            <Panel
              title="New sellers"
              action={
                <Link href="/admin/sellers" className="text-[11px] font-semibold text-brand-600">
                  View all →
                </Link>
              }
            >
              <ul className="space-y-2.5 text-xs">
                {data.newSellers.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink-900">{s.shopName}</p>
                      <p className="truncate text-[11px] text-gray-400">
                        {s.email ?? new Date(s.joinedAt).toLocaleDateString('en-IN')}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        s.status === 'APPROVED'
                          ? 'bg-green-100 text-green-700'
                          : s.status === 'PENDING'
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {s.status}
                    </span>
                  </li>
                ))}
                {data.newSellers.length === 0 && <li className="text-gray-400">No sellers yet.</li>}
              </ul>
            </Panel>

            <Panel title="Top performing sellers" subtitle={OVERVIEW_RANGE_LABELS[data.range.key]}>
              <ul className="space-y-2.5 text-xs">
                {data.topSellers.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-100 text-[10px] font-bold text-gray-500">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink-900">{s.shopName}</p>
                      <p className="text-[11px] text-gray-400">
                        {s.orders} order{s.orders === 1 ? '' : 's'}
                        {s.ratingAvg != null && ` · ★ ${s.ratingAvg}`}
                      </p>
                    </div>
                    <span className="shrink-0 font-semibold text-ink-900">
                      {formatPaise(s.gmvPaise)}
                    </span>
                  </li>
                ))}
                {data.topSellers.length === 0 && (
                  <li className="text-gray-400">No sales in this range.</li>
                )}
              </ul>
            </Panel>

            <Panel
              title="AI Try-On usage"
              action={
                <Link href="/admin/tryon" className="text-[11px] font-semibold text-brand-600">
                  Monitor →
                </Link>
              }
            >
              <div className="flex items-baseline gap-2">
                <p className="font-display text-2xl font-bold text-ink-900">
                  {num(data.tryOn.sessions)}
                </p>
                <p className="text-[11px]">
                  {data.tryOn.sessionsChangePercent !== null ? (
                    <span
                      className={
                        data.tryOn.sessionsChangePercent >= 0 ? 'text-green-600' : 'text-red-600'
                      }
                    >
                      {data.tryOn.sessionsChangePercent >= 0 ? '↑' : '↓'}{' '}
                      {Math.abs(data.tryOn.sessionsChangePercent)}%
                    </span>
                  ) : (
                    <span className="text-gray-400">no prior period</span>
                  )}
                </p>
              </div>
              <p className="text-[11px] text-gray-400">
                {num(data.tryOn.successful)} generated · {data.tryOn.conversionRate}% went on to buy
              </p>
              <div className="mt-2">
                <LineChart
                  points={data.tryOn.trend.map((t) => ({ date: t.date, value: t.count }))}
                  height={96}
                />
              </div>
            </Panel>

            <Panel title="Platform summary" subtitle="All time">
              <dl className="space-y-2 text-xs">
                {[
                  ['Total users', num(data.platformSummary.users)],
                  ['Total sellers', num(data.platformSummary.sellers)],
                  ['Total products', num(data.platformSummary.products)],
                  ['Total orders', num(data.platformSummary.orders)],
                  ['Total returns', num(data.platformSummary.returns)],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <dt className="text-gray-500">{label}</dt>
                    <dd className="font-semibold text-ink-900">{value}</dd>
                  </div>
                ))}
                <div className="flex justify-between gap-2 border-t border-gray-100 pt-2">
                  <dt className="text-gray-500">
                    Revenue ({OVERVIEW_RANGE_LABELS[data.range.key].toLowerCase()})
                  </dt>
                  <dd className="font-semibold text-ink-900">
                    {formatPaise(data.platformSummary.revenuePaise)}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] text-gray-400">
                Revenue is the marketplace&apos;s share — commission plus gateway fee — not GMV.
              </p>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
