'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  TRANSACTION_SORTS,
  TRANSACTION_SORT_LABELS,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TABS,
  TRANSACTION_TAB_LABELS,
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_LABELS,
  type AdminPaymentsSummary,
  type PaymentFilterOptions,
  type ReconcileReport,
  type TransactionPage,
  type TransactionRow,
  type TransactionSort,
  type TransactionStatus,
  type TransactionTab,
  type TransactionType,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BarList, DonutChart, LineChart } from '@/components/charts/Charts';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  SUCCESS: 'bg-green-100 text-green-700',
  PENDING: 'bg-yellow-100 text-yellow-800',
  FAILED: 'bg-red-100 text-red-700',
  REFUNDED: 'bg-purple-100 text-purple-700',
};

const TYPE_STYLES: Record<TransactionType, string> = {
  PAYMENT: 'bg-blue-100 text-blue-700',
  REFUND: 'bg-purple-100 text-purple-700',
  PAYOUT: 'bg-indigo-100 text-indigo-700',
  CREDIT_PURCHASE: 'bg-cream-100 text-gray-600',
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
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Delta({ value, suffix = 'vs previous' }: { value: number | null; suffix?: string }) {
  if (value === null) return <span className="text-gray-400">no prior period</span>;
  return (
    <span className={value >= 0 ? 'text-green-600' : 'text-red-600'}>
      {value >= 0 ? '↑' : '↓'} {Math.abs(value)}% <span className="text-gray-400">{suffix}</span>
    </span>
  );
}

function KpiCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: string;
  label: string;
  value: string;
  hint?: React.ReactNode;
  tone?: 'bad' | 'warn';
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
          <p
            className={`mt-0.5 truncate font-display text-lg font-bold ${
              tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-yellow-600' : 'text-ink-900'
            }`}
          >
            {value}
          </p>
        </div>
      </div>
      {hint && <p className="mt-2 truncate text-[11px]">{hint}</p>}
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

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold text-ink-900">{title}</h3>
          <button
            onClick={onClose}
            className="text-xl leading-none text-gray-400 hover:text-ink-900"
          >
            ×
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminPaymentsPage() {
  const [summary, setSummary] = useState<AdminPaymentsSummary | null>(null);
  const [options, setOptions] = useState<PaymentFilterOptions | null>(null);
  const [page, setPage] = useState<TransactionPage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [q, setQ] = useState('');
  const [tab, setTab] = useState<TransactionTab>('ALL');
  const [type, setType] = useState<'ALL' | TransactionType>('ALL');
  const [status, setStatus] = useState<'ALL' | TransactionStatus>('ALL');
  const [gateway, setGateway] = useState('');
  const [sellerId, setSellerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [moreFilters, setMoreFilters] = useState(false);
  const [sort, setSort] = useState<TransactionSort>('NEWEST');
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [open, setOpen] = useState<TransactionRow | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [reconciling, setReconciling] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      tab,
      type,
      status,
      sort,
      page: String(pageNo),
      pageSize: String(pageSize),
    });
    if (q.trim()) params.set('q', q.trim());
    if (gateway) params.set('gateway', gateway);
    if (sellerId) params.set('sellerId', sellerId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }, [q, tab, type, status, gateway, sellerId, from, to, sort, pageNo, pageSize]);

  const loadList = useCallback(async () => {
    try {
      setPage(await api<TransactionPage>(`/api/admin/payments?${query}`, { auth: true }));
      setError('');
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'Could not load transactions (are you admin?)',
      );
    }
  }, [query]);

  const loadSummary = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([
        api<AdminPaymentsSummary>('/api/admin/payments/summary?days=30', { auth: true }),
        api<PaymentFilterOptions>('/api/admin/payments/meta/options', { auth: true }),
      ]);
      setSummary(s);
      setOptions(o);
    } catch {
      // The table surfaces auth problems; an empty summary is not fatal.
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    setPageNo(1);
  }, [q, tab, type, status, gateway, sellerId, from, to, pageSize]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 6000);
  }, []);

  async function reconcile() {
    setReconciling(true);
    try {
      const result = await api<ReconcileReport>('/api/admin/payments/reconcile', {
        method: 'POST',
        auth: true,
      });
      setReport(result);
      flash(
        result.findings.length === 0
          ? 'Reconciliation clean — every payment, refund and payout agrees with its order.'
          : `Reconciliation found ${result.findings.length} discrepancy(ies).`,
      );
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not run reconciliation.');
    } finally {
      setReconciling(false);
    }
  }

  function resetFilters() {
    setQ('');
    setTab('ALL');
    setType('ALL');
    setStatus('ALL');
    setGateway('');
    setSellerId('');
    setFrom('');
    setTo('');
    setSort('NEWEST');
  }

  const rows = page?.rows ?? [];
  const k = summary?.kpis;

  return (
    <div className="pb-10">
      {/* Header ------------------------------------------------------------ */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">
            Payment &amp; Transaction Management
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Payments, refunds, seller payouts and credit purchases in one ledger — and the checks
            that prove they add up.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => downloadFile(`/api/admin/payments/export?${query}`, 'transactions.csv')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            ⭳ Export Report
          </button>
          <button
            onClick={() =>
              downloadFile(
                `/api/admin/payments/settlement/export?${from ? `from=${from}&` : ''}${to ? `to=${to}` : ''}`,
                'settlement-report.csv',
              )
            }
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            ▤ Settlement Report
          </button>
          <button
            onClick={() => void reconcile()}
            disabled={reconciling}
            className="rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {reconciling ? 'Reconciling…' : '⟳ Reconcile Now'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {notice}
        </div>
      )}

      {/* KPIs -------------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {k ? (
          <>
            <KpiCard
              icon="🧮"
              label="Total transactions"
              value={num(k.totalTransactions)}
              hint={
                <Delta value={k.changePercent.totalTransactions} suffix="payments vs prev 30d" />
              }
            />
            <KpiCard
              icon="✓"
              label="Successful payments"
              value={num(k.successfulPayments)}
              hint={<Delta value={k.changePercent.successfulPayments} />}
            />
            <KpiCard
              icon="⛔"
              label="Failed payments"
              value={num(k.failedPayments)}
              tone={k.failedPayments > 0 ? 'bad' : undefined}
              hint={<Delta value={k.changePercent.failedPayments} />}
            />
            <KpiCard
              icon="↩"
              label="Refunds processed"
              value={num(k.refundsProcessed)}
              hint={<span className="text-gray-400">money returned to shoppers</span>}
            />
            <KpiCard
              icon="💰"
              label="Total GMV"
              value={formatPaise(k.gmvPaise)}
              hint={<Delta value={k.changePercent.gmvPaise} />}
            />
            <KpiCard
              icon="🏦"
              label="Net payouts to sellers"
              value={formatPaise(k.netPayoutsPaise)}
              hint={<span className="text-gray-400">settled in the last 30 days</span>}
            />
          </>
        ) : (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      {/* Filters ----------------------------------------------------------- */}
      <div className="mt-4 flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search transaction ID, order, customer, seller…"
          className="min-w-64 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs outline-none focus:border-brand-600"
        />
        <select
          value={gateway}
          onChange={(e) => setGateway(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="">All gateways</option>
          {(options?.gateways ?? []).map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as 'ALL' | TransactionStatus)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="ALL">All status</option>
          {TRANSACTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TRANSACTION_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as 'ALL' | TransactionType)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="ALL">All transaction types</option>
          {TRANSACTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {TRANSACTION_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select
          value={sellerId}
          onChange={(e) => setSellerId(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="">All sellers</option>
          {(options?.sellers ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => setMoreFilters((v) => !v)}
          className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
            moreFilters ? 'border-brand-600 text-brand-600' : 'border-gray-300 text-gray-700'
          }`}
        >
          ⚙ Filters
        </button>
        <button
          onClick={resetFilters}
          className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
        >
          Reset
        </button>
      </div>

      {moreFilters && (
        <div className="mt-2 flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-cream-50 px-3 py-3">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              From
            </label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              To
            </label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
            />
          </div>
          <p className="text-[11px] text-gray-500">
            The date range also drives the Settlement Report download.
          </p>
        </div>
      )}

      {/* Table + sidebar --------------------------------------------------- */}
      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <div className="xl:col-span-3">
          <section className="rounded-2xl border border-gray-100 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <div className="flex gap-1 overflow-x-auto">
                {TRANSACTION_TABS.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold ${
                      tab === t ? 'bg-cream-100 text-brand-600' : 'text-gray-500 hover:text-ink-900'
                    }`}
                  >
                    {TRANSACTION_TAB_LABELS[t]}
                    {page && (
                      <span className="ml-1 text-[10px] text-gray-400">
                        ({num(page.tabCounts[t] ?? 0)})
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as TransactionSort)}
                className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
              >
                {TRANSACTION_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {TRANSACTION_SORT_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] text-xs">
                <thead>
                  <tr className="text-left uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2.5 font-semibold">Transaction ID</th>
                    <th className="px-3 py-2.5 font-semibold">Order</th>
                    <th className="px-3 py-2.5 font-semibold">Counterparty</th>
                    <th className="px-3 py-2.5 font-semibold">Seller</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Amount</th>
                    <th className="px-3 py-2.5 font-semibold">Gateway</th>
                    <th className="px-3 py-2.5 font-semibold">Type</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th>
                    <th className="px-3 py-2.5 font-semibold">Date &amp; time</th>
                    <th className="px-3 py-2.5 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-t border-gray-100 hover:bg-cream-50">
                      <td className="max-w-44 truncate px-3 py-2.5 font-mono text-brand-600">
                        {r.reference}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.orderNumber ? (
                          <span className="font-mono text-gray-600">{r.orderNumber}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="max-w-44 px-3 py-2.5">
                        <p className="truncate text-ink-900">{r.counterpartyName ?? '—'}</p>
                        <p className="truncate text-[11px] text-gray-400">
                          {r.counterpartySubtitle ?? ''}
                        </p>
                      </td>
                      <td className="max-w-36 truncate px-3 py-2.5 text-gray-600">
                        {r.sellerName ?? '—'}
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right font-semibold ${
                          r.outgoing ? 'text-red-600' : 'text-ink-900'
                        }`}
                      >
                        {r.outgoing ? '− ' : ''}
                        {formatPaise(r.amountPaise)}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600">{r.gateway}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${TYPE_STYLES[r.type]}`}
                        >
                          {r.typeLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            STATUS_STYLES[r.status] ?? 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {r.statusLabel}
                        </span>
                        {r.disputed && (
                          <span className="ml-1 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700">
                            disputed
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                        {when(r.createdAt)}
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => setOpen(r)}
                          className="rounded-lg border border-gray-300 px-2 py-1 font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-4 py-14 text-center text-gray-500">
                        No transactions match those filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {page && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
                <span>
                  Showing {rows.length === 0 ? 0 : (page.page - 1) * page.pageSize + 1}–
                  {(page.page - 1) * page.pageSize + rows.length} of {num(page.total)} transactions
                </span>
                <div className="flex items-center gap-2">
                  <button
                    disabled={page.page <= 1}
                    onClick={() => setPageNo(page.page - 1)}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 disabled:opacity-40"
                  >
                    ‹
                  </button>
                  <span className="font-semibold text-ink-900">
                    {page.page} / {page.totalPages}
                  </span>
                  <button
                    disabled={page.page >= page.totalPages}
                    onClick={() => setPageNo(page.page + 1)}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 disabled:opacity-40"
                  >
                    ›
                  </button>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="rounded-lg border border-gray-300 px-2 py-1"
                  >
                    {[10, 25, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        {n} / page
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Sidebar --------------------------------------------------------- */}
        <div className="space-y-4">
          {summary && (
            <>
              <Panel title="Payment overview" subtitle="Payment attempts, last 30 days">
                <DonutChart
                  slices={summary.paymentOverview.map((p) => ({
                    key: p.key,
                    label: p.label,
                    count: p.count,
                    share: p.share,
                  }))}
                  total={summary.paymentOverview.reduce((sum, p) => sum + p.count, 0)}
                  totalLabel="PAYMENTS"
                  size={120}
                />
                <ul className="mt-3 space-y-1 text-[11px]">
                  {summary.paymentOverview.map((p) => (
                    <li key={p.key} className="flex justify-between gap-2">
                      <span className="text-gray-500">{p.label}</span>
                      <span className="font-semibold text-ink-900">
                        {formatPaise(p.amountPaise)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel title="Gateway performance" subtitle="Success rate on settled attempts">
                <ul className="space-y-2.5 text-xs">
                  {summary.gateways.map((g) => (
                    <li key={g.gateway}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-ink-900">{g.gateway}</span>
                        <span className="text-gray-500">
                          {g.successRate}% · {num(g.transactions)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                        <div
                          className={`h-full rounded-full ${
                            g.successRate >= 95
                              ? 'bg-green-500'
                              : g.successRate >= 85
                                ? 'bg-yellow-500'
                                : 'bg-red-500'
                          }`}
                          style={{ width: `${Math.max(g.successRate, 2)}%` }}
                        />
                      </div>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {formatPaise(g.amountPaise)} collected · {num(g.failed)} failed
                      </p>
                    </li>
                  ))}
                  {summary.gateways.length === 0 && (
                    <li className="text-gray-400">No payment attempts in this period.</li>
                  )}
                </ul>
              </Panel>

              <Panel
                title="Fraud &amp; risk alerts"
                subtitle="Each figure is computed, not sampled"
              >
                <div className="grid grid-cols-2 gap-2">
                  {summary.riskAlerts.map((a) => (
                    <div
                      key={a.key}
                      className="rounded-xl border border-gray-100 px-3 py-2"
                      title={a.detail}
                    >
                      <p className="text-[11px] text-gray-500">{a.label}</p>
                      <p
                        className={`font-display text-lg font-bold ${
                          a.count > 0 ? 'text-red-600' : 'text-gray-400'
                        }`}
                      >
                        {num(a.count)}
                      </p>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel
                title="Recent refunds"
                action={
                  <Link href="/admin/returns" className="text-[11px] font-semibold text-brand-600">
                    View all →
                  </Link>
                }
              >
                <ul className="space-y-2 text-xs">
                  {summary.recentRefunds.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-[11px] text-brand-600">
                          {r.reference}
                        </p>
                        <p className="truncate text-[11px] text-gray-400">
                          {r.orderNumber ?? '—'} · {when(r.createdAt)}
                        </p>
                      </div>
                      <span className="shrink-0 font-semibold text-ink-900">
                        {formatPaise(r.amountPaise)}
                      </span>
                    </li>
                  ))}
                  {summary.recentRefunds.length === 0 && (
                    <li className="text-gray-400">No refunds in this period.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="Financial summary" subtitle="Last 30 days">
                <dl className="space-y-1.5 text-xs">
                  {[
                    ['Total GMV', formatPaise(summary.financials.gmvPaise), ''],
                    ['Commission', formatPaise(summary.financials.commissionPaise), ''],
                    ['Gateway fees', formatPaise(summary.financials.gatewayFeePaise), ''],
                    ['TDS withheld', formatPaise(summary.financials.tdsPaise), 'text-gray-500'],
                    [
                      'Refunds',
                      `− ${formatPaise(summary.financials.refundsPaise)}`,
                      'text-red-600',
                    ],
                  ].map(([label, value, cls]) => (
                    <div key={String(label)} className="flex justify-between gap-2">
                      <dt className="text-gray-500">{label as string}</dt>
                      <dd className={(cls as string) || 'text-ink-900'}>{value as string}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between gap-2 border-t border-gray-100 pt-2">
                    <dt className="font-semibold text-ink-900">Net revenue</dt>
                    <dd className="font-display font-bold text-brand-600">
                      {formatPaise(summary.financials.netRevenuePaise)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-2 text-[11px] text-gray-400">
                  Commission and gateway fees come from raised payouts; GMV not yet covered by a
                  payout is priced at the current platform rates.
                </p>
              </Panel>
            </>
          )}
        </div>
      </div>

      {/* Charts ------------------------------------------------------------ */}
      {summary && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          <Panel title="GMV trend" subtitle="Last 30 days">
            <p className="font-display text-xl font-bold text-ink-900">
              {formatPaise(summary.kpis.gmvPaise)}
            </p>
            <p className="text-[11px]">
              <Delta value={summary.kpis.changePercent.gmvPaise} />
            </p>
            <div className="mt-2">
              <LineChart
                points={summary.gmvTrend.map((t) => ({ date: t.date, value: t.gmvPaise }))}
                format={shortMoney}
                height={140}
              />
            </div>
          </Panel>

          <Panel title="Transaction status distribution" subtitle="Every ledger row">
            <DonutChart
              slices={summary.statusDistribution}
              total={summary.statusDistribution.reduce((sum, s) => sum + s.count, 0)}
              totalLabel="TXNS"
              size={120}
            />
          </Panel>

          <Panel title="Payout summary" subtitle="Last 30 days">
            <div className="space-y-3">
              <div className="rounded-xl bg-cream-50 px-3 py-2">
                <p className="text-[11px] text-gray-500">Settled to sellers</p>
                <p className="font-display text-lg font-bold text-ink-900">
                  {formatPaise(summary.payouts.paidPaise)}
                </p>
              </div>
              <div className="rounded-xl bg-cream-50 px-3 py-2">
                <p className="text-[11px] text-gray-500">Pending payouts</p>
                <p className="font-display text-lg font-bold text-yellow-600">
                  {formatPaise(summary.payouts.pendingPaise)}
                </p>
              </div>
              <div className="rounded-xl bg-cream-50 px-3 py-2">
                <p className="text-[11px] text-gray-500">Sellers paid</p>
                <p className="font-display text-lg font-bold text-ink-900">
                  {num(summary.payouts.sellersPaid)}
                </p>
              </div>
            </div>
          </Panel>

          <Panel title="Settlement status" subtitle="Payouts raised in this period">
            {summary.payouts.byStatus.length > 0 ? (
              <DonutChart
                slices={summary.payouts.byStatus}
                total={summary.payouts.byStatus.reduce((sum, s) => sum + s.count, 0)}
                totalLabel="PAYOUTS"
                size={120}
              />
            ) : (
              <p className="text-xs text-gray-400">No payouts raised in the last 30 days.</p>
            )}
          </Panel>
        </div>
      )}

      {/* Reconciliation report --------------------------------------------- */}
      {report && (
        <Modal title="Reconciliation report" onClose={() => setReport(null)}>
          <p className="text-xs text-gray-500">
            Ran {when(report.ranAt)} across {num(report.checked.payments)} payments,{' '}
            {num(report.checked.refunds)} refunds, {num(report.checked.payouts)} payouts and{' '}
            {num(report.checked.orders)} orders.
          </p>

          <div className="mt-4">
            <BarList
              items={report.byCheck.map((c) => ({
                key: c.check,
                label: c.label,
                percent: c.count > 0 ? 100 : 0,
                value: c.count === 0 ? 'clean' : num(c.count),
              }))}
              color="#EF4444"
            />
          </div>

          {report.findings.length === 0 ? (
            <p className="mt-4 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
              Every payment matches its order, no refund exceeds what was collected, every COD
              delivery is settled and every payout&apos;s net equals gross minus its deductions.
            </p>
          ) : (
            <div className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-gray-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left text-gray-500">
                    <th className="px-2 py-1.5 font-semibold">Check</th>
                    <th className="px-2 py-1.5 font-semibold">Reference</th>
                    <th className="px-2 py-1.5 font-semibold">Order</th>
                    <th className="px-2 py-1.5 font-semibold">Detail</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {report.findings.map((f, i) => (
                    <tr key={`${f.check}-${f.reference}-${i}`} className="border-t border-gray-100">
                      <td className="max-w-48 px-2 py-1.5 text-red-600">{f.label}</td>
                      <td className="max-w-36 truncate px-2 py-1.5 font-mono text-gray-500">
                        {f.reference}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-brand-600">
                        {f.orderNumber ?? '—'}
                      </td>
                      <td className="max-w-64 px-2 py-1.5 text-gray-600">{f.detail}</td>
                      <td className="px-2 py-1.5 text-right font-semibold text-ink-900">
                        {formatPaise(Math.abs(f.differencePaise))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <button
              onClick={() => setReport(null)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {/* Transaction detail ------------------------------------------------ */}
      {open && (
        <Modal title={open.typeLabel} onClose={() => setOpen(null)}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-brand-600">{open.reference}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                STATUS_STYLES[open.status] ?? 'bg-gray-100 text-gray-600'
              }`}
            >
              {open.statusLabel}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TYPE_STYLES[open.type]}`}
            >
              {open.typeLabel}
            </span>
            {open.disputed && (
              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
                open payment dispute
              </span>
            )}
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            {[
              ['Amount', `${open.outgoing ? '− ' : ''}${formatPaise(open.amountPaise)}`],
              ['Direction', open.outgoing ? 'Out of the platform' : 'Into the platform'],
              ['Gateway / method', open.gateway],
              ['Raw status', open.sourceStatus],
              ['Counterparty', open.counterpartyName ?? '—'],
              ['Contact', open.counterpartySubtitle ?? '—'],
              ['Seller', open.sellerName ?? '—'],
              ['When', when(open.createdAt)],
              ['Internal id', open.id],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-gray-500">{label}</dt>
                <dd className="break-all text-ink-900">{value}</dd>
              </div>
            ))}
          </dl>

          {open.failureReason && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {open.failureReason}
            </p>
          )}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {open.orderId && (
              <Link
                href={`/admin/orders?q=${encodeURIComponent(open.orderNumber ?? '')}`}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Open order {open.orderNumber}
              </Link>
            )}
            {open.type === 'REFUND' && (
              <Link
                href="/admin/returns"
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Open return
              </Link>
            )}
            {open.type === 'PAYOUT' && (
              <Link
                href="/admin/sellers"
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Open seller
              </Link>
            )}
            <button
              onClick={() => setOpen(null)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
            >
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
