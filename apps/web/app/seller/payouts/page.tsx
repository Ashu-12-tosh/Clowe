'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PAYOUT_STATUSES,
  type SellerPayoutMethodRow,
  type SellerPayoutOverview,
  type SellerPayoutPage,
  type SellerPayoutRow,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { DonutChart, MultiLineChart } from '@/components/charts/Charts';
import {
  AddMethodModal,
  PayoutDetailDrawer,
  PayoutStatusPill,
} from '@/components/seller/payouts/PayoutModals';

function money(paise: number): string {
  return formatPaise(paise);
}

function shortMoney(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 10000000) return `₹${(rupees / 10000000).toFixed(1)}Cr`;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`;
  if (rupees >= 1000) return `₹${Math.round(rupees / 1000)}K`;
  return `₹${Math.round(rupees)}`;
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

/** Last 6 months, newest first. */
function monthOptions(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 6; i += 1) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
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
        <div>
          <h2 className="text-sm font-bold text-ink-900">{title}</h2>
          {subtitle && <p className="text-[11px] text-gray-400">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function SellerPayoutsPage() {
  const [month, setMonth] = useState(thisMonth());
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [overview, setOverview] = useState<SellerPayoutOverview | null>(null);
  const [history, setHistory] = useState<SellerPayoutPage | null>(null);
  const [openPayout, setOpenPayout] = useState<SellerPayoutRow | null>(null);
  const [addingMethod, setAddingMethod] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadOverview = useCallback(async () => {
    try {
      setOverview(
        await api<SellerPayoutOverview>(`/api/seller/payouts/overview?month=${month}`, {
          auth: true,
        }),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load payouts');
    }
  }, [month]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(
        await api<SellerPayoutPage>(
          `/api/seller/payouts?status=${statusFilter}&page=${page}&pageSize=${pageSize}`,
          { auth: true },
        ),
      );
    } catch {
      setHistory(null);
    }
  }, [statusFilter, page, pageSize]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);
  useEffect(() => setPage(1), [statusFilter, pageSize]);

  async function requestPayout() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payout = await api<SellerPayoutRow>('/api/seller/payouts/request', {
        method: 'POST',
        body: {},
        auth: true,
      });
      setNotice(
        `${payout.reference}: ${money(payout.netPaise)} sent to ${payout.methodLabel ?? 'your account'}${payout.utr ? ` · UTR ${payout.utr}` : ''}`,
      );
      await Promise.all([loadOverview(), loadHistory()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Payout request failed');
    } finally {
      setBusy(false);
    }
  }

  async function setDefaultMethod(methodId: string) {
    try {
      await api(`/api/seller/payouts/methods/${methodId}/default`, { method: 'PATCH', auth: true });
      await loadOverview();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update the method');
    }
  }

  async function removeMethod(method: SellerPayoutMethodRow) {
    if (!confirm(`Remove ${method.label}? Payouts will use your other method.`)) return;
    try {
      await api(`/api/seller/payouts/methods/${method.id}`, { method: 'DELETE', auth: true });
      await loadOverview();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not remove the method');
    }
  }

  const k = overview?.kpis;
  const canRequest =
    !!k && !!overview && k.payablePaise >= overview.rates.minPayoutPaise && overview.methods.length > 0;

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Payouts Overview</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Track your earnings, payouts, fees and TDS. Money is earned on delivery and clears after
            the return window.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold outline-none"
          >
            {monthOptions().map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              void downloadFile(
                `/api/seller/payouts/statement?month=${month}`,
                `clowe-statement-${month}.csv`,
              ).catch(() => setError('Download failed'))
            }
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            ⬇ Download statement
          </button>
          <button
            onClick={() =>
              void downloadFile('/api/seller/payouts/tds-report', 'clowe-tds-report.csv').catch(() =>
                setError('Download failed'),
              )
            }
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            🧾 TDS report
          </button>
          <button
            onClick={() => void requestPayout()}
            disabled={!canRequest || busy}
            title={
              !overview
                ? undefined
                : overview.methods.length === 0
                  ? 'Add a payout method first'
                  : k && k.payablePaise < overview.rates.minPayoutPaise
                    ? `Minimum payout is ${money(overview.rates.minPayoutPaise)}`
                    : undefined
            }
            className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Requesting…' : '＋ Request payout'}
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

      {/* --- KPI cards --------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {k && overview ? (
          <>
            <KpiCard
              icon="🧾"
              label={`Gross sales (${monthLabel(month).split(' ')[0]})`}
              value={money(k.monthGrossPaise)}
              footer={<Delta change={k.monthGrossChangePercent} />}
            />
            <KpiCard
              icon="💰"
              label="Net earnings"
              value={money(k.monthNetPaise)}
              footer={<Delta change={k.monthNetChangePercent} />}
            />
            <KpiCard
              icon="🏦"
              label="Amount payable"
              value={money(k.payablePaise)}
              footer={
                k.payablePaise >= overview.rates.minPayoutPaise
                  ? 'Available for transfer'
                  : `Minimum ${money(overview.rates.minPayoutPaise)}`
              }
            />
            <KpiCard
              icon="⏳"
              label="In clearing"
              value={money(k.inClearingPaise)}
              footer={
                k.nextClearingAt
                  ? `Next release ${new Date(k.nextClearingAt).toLocaleDateString('en-IN')}`
                  : `Clears ${overview.rates.holdDays} days after delivery`
              }
            />
            <KpiCard
              icon="📤"
              label="Total paid out"
              value={money(k.lifetimePaidPaise)}
              footer={`Across ${k.payoutCount} payout${k.payoutCount === 1 ? '' : 's'}`}
            />
            <KpiCard
              icon="✅"
              label="Payout success rate"
              value={`${k.successRate}%`}
              footer={k.successRate >= 95 ? 'Excellent' : 'Some payouts failed'}
            />
          </>
        ) : (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <div className="space-y-4 xl:col-span-3">
          {/* --- Trend + breakdown ------------------------------------- */}
          {overview && (
            <div className="grid gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <Panel title="Earnings trend" subtitle={`Delivered value per day · ${monthLabel(month)}`}>
                  <MultiLineChart
                    format={shortMoney}
                    series={[
                      {
                        key: 'gross',
                        label: 'Gross sales',
                        color: '#B8860B',
                        fill: true,
                        points: overview.trend.map((t) => ({ date: t.date, value: t.grossPaise })),
                      },
                      {
                        key: 'net',
                        label: 'Net earnings',
                        color: '#141414',
                        points: overview.trend.map((t) => ({ date: t.date, value: t.netPaise })),
                      },
                      {
                        key: 'fees',
                        label: 'Fees + TDS',
                        color: '#9CA3AF',
                        dashed: true,
                        points: overview.trend.map((t) => ({ date: t.date, value: t.feesPaise })),
                      },
                    ]}
                  />
                </Panel>
              </div>
              <div className="lg:col-span-2">
                <Panel title="Earnings breakdown" subtitle="Where this month's gross came from">
                  <DonutChart
                    slices={overview.breakdown
                      .filter((b) => b.key !== 'cod')
                      .map((b) => ({
                        key: b.key,
                        label: b.label,
                        count: Math.round(b.amountPaise / 100),
                        share: b.share,
                      }))}
                    total={Math.round(k ? k.monthGrossPaise / 100 : 0)}
                    totalLabel="GROSS ₹"
                  />
                  <ul className="mt-3 space-y-1 border-t border-gray-100 pt-2 text-xs">
                    {overview.breakdown.map((b) => (
                      <li key={b.key} className="flex justify-between">
                        <span className="text-gray-500">{b.label}</span>
                        <span className="font-semibold text-ink-900">{money(b.amountPaise)}</span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              </div>
            </div>
          )}

          {/* --- Payout history ---------------------------------------- */}
          <section className="rounded-2xl border border-gray-100 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
              <h2 className="text-sm font-bold text-ink-900">Payouts history</h2>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
              >
                <option value="ALL">All statuses</option>
                {PAYOUT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-xs">
                <thead>
                  <tr className="text-left uppercase tracking-wide text-gray-500">
                    <th className="px-4 py-2.5 font-semibold">Payout ID</th>
                    <th className="px-4 py-2.5 font-semibold">Requested</th>
                    <th className="px-4 py-2.5 font-semibold">Period</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Gross</th>
                    <th className="px-4 py-2.5 text-right font-semibold">TDS</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Fees</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Net paid</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    <th className="px-4 py-2.5 font-semibold">Method</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {history?.rows.map((p) => (
                    <tr key={p.id} className="border-t border-gray-100 hover:bg-cream-50">
                      <td className="px-4 py-2.5 font-mono font-semibold text-brand-600">
                        {p.reference}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-500">
                        {new Date(p.requestedAt).toLocaleDateString('en-IN')}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-500">
                        {new Date(p.periodFrom).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                        })}{' '}
                        –{' '}
                        {new Date(p.periodTo).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </td>
                      <td className="px-4 py-2.5 text-right">{money(p.grossPaise)}</td>
                      <td className="px-4 py-2.5 text-right text-red-600">{money(p.tdsPaise)}</td>
                      <td className="px-4 py-2.5 text-right text-red-600">
                        {money(p.feesPaise + p.adjustmentPaise)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold text-ink-900">
                        {money(p.netPaise)}
                      </td>
                      <td className="px-4 py-2.5">
                        <PayoutStatusPill status={p.status} />
                      </td>
                      <td className="px-4 py-2.5 text-gray-500">{p.methodLabel ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => setOpenPayout(p)}
                          className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold hover:bg-gray-50"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                  {history && history.rows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-4 py-12 text-center text-gray-500">
                        No payouts yet. Deliver orders, let them clear, then request your first
                        transfer.
                      </td>
                    </tr>
                  )}
                  {!history && (
                    <tr>
                      <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                        Loading…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {history && history.total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-4 py-2.5 text-xs">
                <p className="text-gray-500">
                  Showing {(history.page - 1) * history.pageSize + 1}–
                  {Math.min(history.page * history.pageSize, history.total)} of {history.total}{' '}
                  payouts
                </p>
                <div className="flex items-center gap-2">
                  <button
                    disabled={history.page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold disabled:opacity-40"
                  >
                    ‹
                  </button>
                  <span className="text-gray-600">
                    Page {history.page} / {history.totalPages}
                  </span>
                  <button
                    disabled={history.page >= history.totalPages}
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
          </section>

          {/* --- Fees / TDS / insights ---------------------------------- */}
          {overview && (
            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title="Fees breakdown" subtitle={monthLabel(month)}>
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">
                      Commission ({overview.rates.commissionPercent}%)
                    </dt>
                    <dd className="font-semibold">{money(overview.fees.commissionPaise)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">
                      Gateway / collection ({overview.rates.gatewayPercent}%)
                    </dt>
                    <dd className="font-semibold">{money(overview.fees.gatewayPaise)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Ad spend recovery</dt>
                    <dd className="font-semibold">{money(overview.fees.adjustmentsPaise)}</dd>
                  </div>
                  <div className="flex justify-between border-t border-gray-100 pt-2 text-sm font-bold text-ink-900">
                    <dt>Total fees</dt>
                    <dd>{money(overview.fees.totalPaise)}</dd>
                  </div>
                </dl>
              </Panel>

              <Panel title="TDS summary" subtitle={`FY ${overview.tds.financialYear} · section 194-O`}>
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Gross sales (FY)</dt>
                    <dd className="font-semibold">{money(overview.tds.grossSalesPaise)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">TDS withheld ({overview.rates.tdsPercent}%)</dt>
                    <dd className="font-semibold">{money(overview.tds.tdsWithheldPaise)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Deposited with payouts</dt>
                    <dd className="font-semibold text-green-700">
                      {money(overview.tds.tdsDepositedPaise)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-2 text-[11px] text-gray-400">
                  Withheld TDS is deposited against your PAN with the payout that carried it.
                </p>
              </Panel>

              <Panel title="Insights">
                <ul className="space-y-2.5 text-xs">
                  {overview.insights.map((insight) => (
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
                  {overview.insights.length === 0 && (
                    <li className="text-gray-400">Nothing to flag right now.</li>
                  )}
                </ul>
              </Panel>
            </div>
          )}
        </div>

        {/* --- Sidebar --------------------------------------------------- */}
        <div className="space-y-4">
          {overview && (
            <>
              <Panel title="Payout summary" subtitle={monthLabel(month)}>
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Opening balance</dt>
                    <dd className="font-semibold">{money(overview.summary.openingBalancePaise)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Gross earnings</dt>
                    <dd className="font-semibold text-green-700">
                      + {money(overview.summary.earningsPaise)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Fees &amp; charges</dt>
                    <dd className="font-semibold text-red-600">
                      − {money(overview.summary.feesPaise)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">TDS deducted</dt>
                    <dd className="font-semibold text-red-600">
                      − {money(overview.summary.tdsPaise)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Adjustments (ads)</dt>
                    <dd className="font-semibold text-red-600">
                      − {money(overview.summary.adjustmentsPaise)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Paid out this month</dt>
                    <dd className="font-semibold text-red-600">
                      − {money(overview.summary.paidOutPaise)}
                    </dd>
                  </div>
                  <div className="flex justify-between border-t border-gray-100 pt-2 text-sm font-bold text-ink-900">
                    <dt>Amount payable</dt>
                    <dd>{money(overview.summary.payablePaise)}</dd>
                  </div>
                </dl>
                <p className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-[11px] text-gray-600">
                  Minimum payout {money(overview.rates.minPayoutPaise)} · earnings clear{' '}
                  {overview.rates.holdDays} days after delivery
                </p>
              </Panel>

              <Panel
                title="Payout methods"
                action={
                  <button
                    onClick={() => setAddingMethod(true)}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 text-[11px] font-semibold hover:bg-gray-50"
                  >
                    ＋ Add
                  </button>
                }
              >
                <ul className="space-y-2 text-xs">
                  {overview.methods.map((m) => (
                    <li
                      key={m.id}
                      className="rounded-xl border border-gray-100 p-3 hover:border-gray-300"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-ink-900">
                            {m.type === 'UPI' ? '📱' : '🏦'} {m.label}
                          </p>
                          <p className="truncate text-gray-500">
                            {m.type === 'UPI' ? m.upiId : `•••• ${m.accountLast4} · ${m.ifsc}`}
                          </p>
                          <p className="truncate text-[11px] text-gray-400">{m.accountName}</p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            m.verified
                              ? 'bg-green-100 text-green-700'
                              : 'bg-yellow-100 text-yellow-700'
                          }`}
                        >
                          {m.verified ? 'Verified' : 'Unverified'}
                        </span>
                      </div>
                      <div className="mt-2 flex gap-3 text-[11px]">
                        {m.isDefault ? (
                          <span className="font-semibold text-brand-600">Default</span>
                        ) : (
                          <button
                            onClick={() => void setDefaultMethod(m.id)}
                            className="text-gray-500 hover:text-brand-600"
                          >
                            Make default
                          </button>
                        )}
                        <button
                          onClick={() => void removeMethod(m)}
                          className="text-gray-500 hover:text-red-600"
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                  {overview.methods.length === 0 && (
                    <li className="text-gray-400">
                      No payout method yet — add a bank account or UPI ID to get paid.
                    </li>
                  )}
                </ul>
              </Panel>

              <Panel title="Recent payouts">
                <ul className="space-y-2 text-xs">
                  {overview.recentPayouts.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => setOpenPayout(p)}
                        className="flex w-full items-center justify-between gap-2 text-left hover:text-brand-600"
                      >
                        <span>
                          <span className="font-mono font-semibold">{p.reference}</span>
                          <span className="block text-[11px] text-gray-400">
                            {new Date(p.requestedAt).toLocaleDateString('en-IN')}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="font-semibold text-ink-900">{money(p.netPaise)}</span>
                          <span className="mt-0.5 block">
                            <PayoutStatusPill status={p.status} />
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {overview.recentPayouts.length === 0 && (
                    <li className="text-gray-400">No payouts yet.</li>
                  )}
                </ul>
              </Panel>
            </>
          )}
          {!overview && <div className="h-64 animate-pulse rounded-2xl bg-gray-100" />}
        </div>
      </div>

      {openPayout && <PayoutDetailDrawer payout={openPayout} onClose={() => setOpenPayout(null)} />}
      {addingMethod && (
        <AddMethodModal
          onClose={() => setAddingMethod(false)}
          onSaved={() => {
            void loadOverview();
            setNotice('Payout method added and verified.');
          }}
        />
      )}
    </div>
  );
}
