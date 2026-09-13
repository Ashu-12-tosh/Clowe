'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ADMIN_RETURN_SORTS,
  ADMIN_RETURN_SORT_LABELS,
  ADMIN_RETURN_TABS,
  ADMIN_RETURN_TAB_LABELS,
  RETURN_REASONS,
  RETURN_REASON_LABELS,
  RETURN_RESOLUTIONS,
  RETURN_RESOLUTION_LABELS,
  type AdminReturnBulkResult,
  type AdminReturnDetail,
  type AdminReturnFilterOptions,
  type AdminReturnListRow,
  type AdminReturnPage,
  type AdminReturnSort,
  type AdminReturnTab,
  type AdminReturnsSummary,
  type ReturnPolicyView,
  type ReturnReasonValue,
  type ReturnResolutionValue,
  type ReturnStage,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BarList, DonutChart, LineChart } from '@/components/charts/Charts';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const STAGE_STYLES: Record<ReturnStage, string> = {
  PENDING_REVIEW: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-blue-100 text-blue-700',
  IN_TRANSIT: 'bg-indigo-100 text-indigo-700',
  QC: 'bg-purple-100 text-purple-700',
  REFUNDED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
};

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';
const labelClass = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500';

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

function age(hours: number): string {
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-gray-400">no prior period</span>;
  return (
    <span className={value >= 0 ? 'text-green-600' : 'text-red-600'}>
      {value >= 0 ? '↑' : '↓'} {Math.abs(value)}%{' '}
      <span className="text-gray-400">vs previous 30d</span>
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
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className={`max-h-[88vh] w-full overflow-y-auto rounded-2xl bg-white p-5 ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
      >
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

export default function AdminReturnsPage() {
  const [summary, setSummary] = useState<AdminReturnsSummary | null>(null);
  const [options, setOptions] = useState<AdminReturnFilterOptions | null>(null);
  const [page, setPage] = useState<AdminReturnPage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [q, setQ] = useState('');
  const [tab, setTab] = useState<AdminReturnTab>('ALL');
  const [reason, setReason] = useState<'ALL' | ReturnReasonValue>('ALL');
  const [resolution, setResolution] = useState<'ALL' | ReturnResolutionValue>('ALL');
  const [sellerId, setSellerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [moreFilters, setMoreFilters] = useState(false);
  const [sort, setSort] = useState<AdminReturnSort>('NEWEST');
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [modal, setModal] = useState<'POLICY' | 'MANUAL_REFUND' | null>(null);
  const [bulkMenu, setBulkMenu] = useState(false);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      tab,
      reason,
      resolution,
      sort,
      page: String(pageNo),
      pageSize: String(pageSize),
    });
    if (q.trim()) params.set('q', q.trim());
    if (sellerId) params.set('sellerId', sellerId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }, [q, tab, reason, resolution, sellerId, from, to, sort, pageNo, pageSize]);

  const loadList = useCallback(async () => {
    try {
      setPage(await api<AdminReturnPage>(`/api/admin/returns?${query}`, { auth: true }));
      setError('');
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Could not load returns (are you admin?)',
      );
    }
  }, [query]);

  const loadSummary = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([
        api<AdminReturnsSummary>('/api/admin/returns/summary?days=30', { auth: true }),
        api<AdminReturnFilterOptions>('/api/admin/returns/meta/options', { auth: true }),
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
    setSelected(new Set());
  }, [q, tab, reason, resolution, sellerId, from, to, pageSize]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 6000);
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadList(), loadSummary()]);
  }, [loadList, loadSummary]);

  async function runBulk(action: string) {
    setBulkMenu(false);
    const body: Record<string, unknown> = { ids: [...selected], action };

    if (action === 'REJECT' || action === 'OVERRIDE') {
      const note = window.prompt(
        action === 'REJECT'
          ? 'Reason the shopper will see for the rejection:'
          : 'Why is the seller decision being overturned?',
      );
      if (note === null) return;
      if (note.trim().length < 3) {
        flash('Give a reason of at least 3 characters.');
        return;
      }
      body.note = note.trim();
    }
    if (action === 'MARK_RECEIVED') {
      body.qcPassed = window.confirm(
        'Did the items pass the quality check?\n\nOK = passed (refund can follow)\nCancel = failed (no refund)',
      );
    }

    setBusy(true);
    try {
      const result = await api<AdminReturnBulkResult>('/api/admin/returns/bulk', {
        method: 'POST',
        auth: true,
        body,
      });
      flash(
        `${result.applied} return(s) updated${
          result.skipped.length > 0
            ? `. Skipped: ${result.skipped.map((s) => `${s.rmaNumber} (${s.reason})`).join('; ')}`
            : '.'
        }`,
      );
      setSelected(new Set());
      await refreshAll();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not apply that.');
    } finally {
      setBusy(false);
    }
  }

  function resetFilters() {
    setQ('');
    setTab('ALL');
    setReason('ALL');
    setResolution('ALL');
    setSellerId('');
    setFrom('');
    setTo('');
    setSort('NEWEST');
  }

  const rows = page?.rows ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const k = summary?.kpis;

  return (
    <div className="pb-10" onClick={() => setBulkMenu(false)}>
      {/* Header ------------------------------------------------------------ */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">
            Returns &amp; Refund Management
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Every return across every shop — approve, track the parcel back, QC it and settle the
            money.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => downloadFile(`/api/admin/returns/meta/export?${query}`, 'returns.csv')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            ⭳ Export Report
          </button>
          <button
            onClick={() => setModal('POLICY')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            ▤ Return Policy
          </button>
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setBulkMenu((v) => !v)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              ⚙ Bulk Actions{selected.size > 0 ? ` (${selected.size})` : ''} ▾
            </button>
            {bulkMenu && (
              <div className="absolute right-0 z-30 mt-1 w-72 rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
                {selected.size === 0 ? (
                  <p className="px-3 py-3 text-[11px] text-gray-500">
                    Tick returns in the table first — bulk actions apply to the selection, and each
                    one is checked against its own stage.
                  </p>
                ) : (
                  [
                    ['APPROVE', 'Approve', 'Only returns awaiting review'],
                    ['REJECT', 'Reject', 'Asks for a reason the shopper sees'],
                    ['MARK_PICKED_UP', 'Mark picked up', 'Approved returns become in transit'],
                    ['MARK_RECEIVED', 'Mark received + QC', 'Records the quality-check outcome'],
                    ['REFUND', 'Issue refund', 'Only after a passed QC'],
                    ['OVERRIDE', 'Override rejection', 'Reopens a seller-rejected return'],
                  ].map(([action, label, hint]) => (
                    <button
                      key={action}
                      disabled={busy}
                      onClick={() => void runBulk(action)}
                      className="block w-full px-3 py-2 text-left hover:bg-cream-50 disabled:opacity-50"
                    >
                      <span className="block text-xs font-semibold text-ink-900">{label}</span>
                      <span className="block text-[11px] text-gray-400">{hint}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => setModal('MANUAL_REFUND')}
            className="rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-brand-700"
          >
            + Create Manual Refund
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
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {k ? (
          <>
            <KpiCard
              icon="↩"
              label="Total requests"
              value={num(k.total)}
              hint={<Delta value={k.changePercent.total} />}
            />
            <KpiCard
              icon="⏳"
              label="Pending review"
              value={num(k.pendingReview)}
              hint={<span className="text-gray-400">seller has not decided</span>}
              tone={k.pendingReview > 0 ? 'warn' : undefined}
            />
            <KpiCard
              icon="✓"
              label="Approved"
              value={num(k.approved + k.inTransit)}
              hint={<span className="text-gray-400">{num(k.inTransit)} in transit</span>}
            />
            <KpiCard
              icon="💸"
              label="Refunds processed"
              value={formatPaise(k.refundedPaise)}
              hint={<Delta value={k.changePercent.refundedPaise} />}
            />
            <KpiCard
              icon="🎁"
              label="Store credit issued"
              value={formatPaise(k.storeCreditPaise)}
              hint={<span className="text-gray-400">settled as Clowe Credits</span>}
            />
            <KpiCard
              icon="⛔"
              label="Rejected"
              value={num(k.rejected)}
              hint={
                <span className="text-gray-400">
                  {num(summary?.risk.disputedReturns ?? 0)} awaiting review
                </span>
              }
              tone={k.rejected > 0 ? 'bad' : undefined}
            />
            <KpiCard
              icon="📊"
              label="Return rate"
              value={`${k.returnRatePercent}%`}
              hint={
                <span className="text-gray-400">of {num(k.deliveredItems)} delivered items</span>
              }
            />
          </>
        ) : (
          Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      {/* Filters ----------------------------------------------------------- */}
      <div className="mt-4 flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search RMA, order, customer, product, seller…"
          className="min-w-64 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs outline-none focus:border-brand-600"
        />
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as 'ALL' | ReturnReasonValue)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="ALL">All return reasons</option>
          {RETURN_REASONS.map((r) => (
            <option key={r} value={r}>
              {RETURN_REASON_LABELS[r]}
            </option>
          ))}
        </select>
        <select
          value={resolution}
          onChange={(e) => setResolution(e.target.value as 'ALL' | ReturnResolutionValue)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="ALL">All resolutions</option>
          {RETURN_RESOLUTIONS.map((r) => (
            <option key={r} value={r}>
              {RETURN_RESOLUTION_LABELS[r]}
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
            <label className={labelClass}>Requested from</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className={labelClass}>Requested to</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
            />
          </div>
        </div>
      )}

      {/* Table + drawer ---------------------------------------------------- */}
      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <div className={openId ? 'xl:col-span-3' : 'xl:col-span-3'}>
          <section className="rounded-2xl border border-gray-100 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <div className="flex gap-1 overflow-x-auto">
                {ADMIN_RETURN_TABS.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold ${
                      tab === t ? 'bg-cream-100 text-brand-600' : 'text-gray-500 hover:text-ink-900'
                    }`}
                  >
                    {ADMIN_RETURN_TAB_LABELS[t]}
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
                onChange={(e) => setSort(e.target.value as AdminReturnSort)}
                className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
              >
                {ADMIN_RETURN_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {ADMIN_RETURN_SORT_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] text-xs">
                <thead>
                  <tr className="text-left uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                        }
                      />
                    </th>
                    <th className="px-3 py-2.5 font-semibold">RMA / order</th>
                    <th className="px-3 py-2.5 font-semibold">Customer</th>
                    <th className="px-3 py-2.5 font-semibold">Seller</th>
                    <th className="px-3 py-2.5 font-semibold">Item</th>
                    <th className="px-3 py-2.5 font-semibold">Reason</th>
                    <th className="px-3 py-2.5 font-semibold">Stage</th>
                    <th className="px-3 py-2.5 font-semibold">Resolution</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Refund</th>
                    <th className="px-3 py-2.5 font-semibold">Requested</th>
                    <th className="px-3 py-2.5 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <ReturnRow
                      key={r.id}
                      row={r}
                      active={openId === r.id}
                      checked={selected.has(r.id)}
                      onCheck={(on) => {
                        const next = new Set(selected);
                        if (on) next.add(r.id);
                        else next.delete(r.id);
                        setSelected(next);
                      }}
                      onOpen={() => setOpenId(openId === r.id ? null : r.id)}
                    />
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={11} className="px-4 py-14 text-center text-gray-500">
                        No returns match those filters.
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
                  {(page.page - 1) * page.pageSize + rows.length} of {num(page.total)} return
                  requests
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

          {/* Charts ------------------------------------------------------- */}
          {summary && (
            <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
              <Panel title="Return trend" subtitle="Last 30 days">
                <LineChart
                  points={summary.trend.map((t) => ({ date: t.date, value: t.returns }))}
                  height={140}
                />
                <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                  Refunded
                </p>
                <LineChart
                  points={summary.trend.map((t) => ({ date: t.date, value: t.refundedPaise }))}
                  color="#141414"
                  format={shortMoney}
                  height={80}
                />
              </Panel>

              <Panel title="Resolution split" subtitle="How returns were settled">
                {summary.resolutionBreakdown.length > 0 ? (
                  <DonutChart
                    slices={summary.resolutionBreakdown}
                    total={summary.resolutionBreakdown.reduce((sum, s) => sum + s.count, 0)}
                    totalLabel="RETURNS"
                    size={120}
                  />
                ) : (
                  <p className="text-xs text-gray-400">No returns in this period.</p>
                )}
                <p className="mt-2 text-[11px] text-gray-400">
                  Exchanges and replacements are not built yet — a return is settled as money back
                  or as Clowe Credits.
                </p>
              </Panel>

              <Panel title="QC / processing status" subtitle="Where the parcels are">
                {summary.qcBreakdown.length > 0 ? (
                  <DonutChart
                    slices={summary.qcBreakdown}
                    total={summary.qcBreakdown.reduce((sum, s) => sum + s.count, 0)}
                    totalLabel="RETURNS"
                    size={120}
                  />
                ) : (
                  <p className="text-xs text-gray-400">Nothing in the pipeline.</p>
                )}
              </Panel>

              <Panel title="Return rate analysis" subtitle="All time">
                <p className="font-display text-2xl font-bold text-ink-900">
                  {summary.kpis.returnRatePercent}%
                </p>
                <p className="text-[11px] text-gray-400">of delivered items came back</p>
                <dl className="mt-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Delivered items</dt>
                    <dd className="font-semibold text-ink-900">
                      {num(summary.kpis.deliveredItems)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Returns (30d)</dt>
                    <dd className="font-semibold text-ink-900">{num(summary.kpis.total)}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                  By seller
                </p>
                <div className="mt-1">
                  <BarList
                    items={summary.topSellers.map((s) => ({
                      key: s.id,
                      label: s.name,
                      percent: Math.min(100, s.returnRatePercent),
                      value: `${s.returnRatePercent}%`,
                      hint: `${num(s.returns)} returns`,
                    }))}
                  />
                </div>
              </Panel>
            </div>
          )}
        </div>

        {/* Sidebar --------------------------------------------------------- */}
        <div className="space-y-4">
          {openId ? (
            <ReturnDrawer
              returnId={openId}
              onClose={() => setOpenId(null)}
              flash={flash}
              onChanged={refreshAll}
            />
          ) : (
            summary && (
              <>
                <Panel title="Return overview" subtitle="Last 30 days">
                  {summary.stageDistribution.length > 0 ? (
                    <DonutChart
                      slices={summary.stageDistribution}
                      total={summary.kpis.total}
                      totalLabel="RETURNS"
                      size={120}
                    />
                  ) : (
                    <p className="text-xs text-gray-400">No returns in this period.</p>
                  )}
                </Panel>

                <Panel title="Return reasons" subtitle="Why shoppers send things back">
                  <BarList
                    numbered
                    items={summary.reasonBreakdown.map((r) => ({
                      key: r.key,
                      label: r.label,
                      percent: r.share,
                      value: num(r.count),
                      hint: `${r.share}%`,
                    }))}
                  />
                </Panel>

                <Panel
                  title="Fraud &amp; risk detection"
                  subtitle="Rule-based, not a black-box score"
                >
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      ['High-risk shoppers', summary.risk.highRiskCustomers],
                      ['Disputed returns', summary.risk.disputedReturns],
                      ['Damage claims, no photo', summary.risk.missingPhotoDamageClaims],
                      ['Refunds stuck 48h+', summary.risk.lateRefunds],
                    ].map(([label, count]) => (
                      <div
                        key={String(label)}
                        className="rounded-xl border border-gray-100 px-3 py-2"
                      >
                        <p className="text-[11px] text-gray-500">{label as string}</p>
                        <p
                          className={`font-display text-lg font-bold ${
                            (count as number) > 0 ? 'text-red-600' : 'text-gray-400'
                          }`}
                        >
                          {num(count as number)}
                        </p>
                      </div>
                    ))}
                  </div>

                  {summary.risk.rows.length > 0 && (
                    <ul className="mt-3 space-y-2 text-xs">
                      {summary.risk.rows.map((r) => (
                        <li key={r.userId} className="rounded-lg bg-cream-50 px-2.5 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-ink-900">
                              {r.name ?? `+91 ${r.phone}`}
                            </span>
                            <span className="shrink-0 font-semibold text-red-600">
                              {r.returnRatePercent}%
                            </span>
                          </div>
                          <p className="text-[11px] text-gray-500">
                            {num(r.returns)} of {num(r.deliveredItems)} items ·{' '}
                            {formatPaise(r.refundedPaise)} refunded
                          </p>
                          <p className="mt-0.5 text-[11px] text-gray-400">{r.flags.join(' · ')}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-[11px] text-gray-400">
                    A shopper is flagged when they return at least 50% of what they receive (over 3+
                    items) or have raised 3+ returns. The rules that fired are listed on each row.
                  </p>
                </Panel>

                <Panel title="Quick actions">
                  <div className="grid grid-cols-2 gap-2 text-[11px] font-semibold">
                    {(
                      [
                        ['Pending review', 'PENDING_REVIEW'],
                        ['Disputed', 'DISPUTED'],
                        ['Awaiting QC', 'QC'],
                        ['In transit', 'IN_TRANSIT'],
                      ] as const
                    ).map(([label, target]) => (
                      <button
                        key={target}
                        onClick={() => setTab(target)}
                        className="rounded-lg border border-gray-200 px-3 py-2 text-center text-gray-700 hover:border-brand-600 hover:text-brand-600"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() =>
                      downloadFile(`/api/admin/returns/meta/export?${query}`, 'returns.csv')
                    }
                    className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    ⭳ Download RMA report
                  </button>
                </Panel>
              </>
            )
          )}
        </div>
      </div>

      {modal === 'POLICY' && <PolicyModal onClose={() => setModal(null)} flash={flash} />}
      {modal === 'MANUAL_REFUND' && (
        <ManualRefundModal
          onClose={() => setModal(null)}
          onDone={async (message) => {
            setModal(null);
            flash(message);
            await refreshAll();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

function ReturnRow({
  row,
  active,
  checked,
  onCheck,
  onOpen,
}: {
  row: AdminReturnListRow;
  active: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <tr className={`border-t border-gray-100 ${active ? 'bg-cream-50' : 'hover:bg-cream-50'}`}>
      <td className="px-3 py-2.5">
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
      </td>
      <td className="px-3 py-2.5">
        <p className="font-mono text-brand-600">{row.rmaNumber}</p>
        <p className="font-mono text-[11px] text-gray-400">{row.orderNumber}</p>
      </td>
      <td className="max-w-40 px-3 py-2.5">
        <p className="truncate text-ink-900">{row.customer.name ?? '—'}</p>
        <p className="truncate text-[11px] text-gray-400">
          {row.customer.email ?? `+91 ${row.customer.phone}`}
        </p>
      </td>
      <td className="max-w-32 truncate px-3 py-2.5 text-gray-600">{row.seller.name}</td>
      <td className="max-w-48 px-3 py-2.5">
        <div className="flex items-center gap-2">
          {row.item.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.item.imageUrl}
              alt=""
              className="h-8 w-7 shrink-0 rounded border border-gray-200 object-cover"
            />
          ) : (
            <div className="h-8 w-7 shrink-0 rounded bg-gray-100" />
          )}
          <div className="min-w-0">
            <p className="truncate text-ink-900">{row.item.title}</p>
            <p className="truncate text-[11px] text-gray-400">
              {row.item.variantLabel ? ` · ` : ''}×{row.item.quantity}
            </p>
          </div>
        </div>
      </td>
      <td className="max-w-36 px-3 py-2.5">
        <p className="truncate text-gray-700">{row.reasonLabel}</p>
        {row.photos.length > 0 && (
          <p className="text-[11px] text-gray-400">{row.photos.length} photo(s)</p>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span
          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${STAGE_STYLES[row.stage]}`}
        >
          {row.stageLabel}
        </span>
        {row.disputed && (
          <span className="ml-1 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700">
            disputed
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-gray-600">{row.resolutionLabel}</td>
      <td className="px-3 py-2.5 text-right">
        <p className="font-semibold text-ink-900">{formatPaise(row.refundAmountPaise)}</p>
        {row.refundStatus && (
          <p className="text-[11px] text-gray-400">{row.refundStatus.toLowerCase()}</p>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
        {when(row.requestedAt)}
        <span className="block text-[11px] text-gray-400">{age(row.ageHours)} ago</span>
      </td>
      <td className="px-3 py-2.5">
        <button
          onClick={onOpen}
          className="rounded-lg border border-gray-300 px-2 py-1 font-semibold text-gray-700 hover:bg-gray-50"
        >
          {active ? 'Close' : 'View'}
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

function ReturnDrawer({
  returnId,
  onClose,
  flash,
  onChanged,
}: {
  returnId: string;
  onClose: () => void;
  flash: (m: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<AdminReturnDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [resolution, setResolution] = useState<ReturnResolutionValue>('REFUND');
  const [qcNote, setQcNote] = useState('');

  const load = useCallback(async () => {
    setDetail(await api<AdminReturnDetail>(`/api/admin/returns/${returnId}`, { auth: true }));
  }, [returnId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      await api(`/api/admin/returns/${returnId}/action`, {
        method: 'POST',
        auth: true,
        body: { action, ...extra },
      });
      flash(`${detail?.rmaNumber ?? 'Return'} updated.`);
      setRefunding(false);
      setQcNote('');
      await load();
      await onChanged();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not apply that.');
    } finally {
      setBusy(false);
    }
  }

  function withNote(action: string, prompt: string) {
    const note = window.prompt(prompt);
    if (note === null) return;
    if (note.trim().length < 3) {
      flash('Give a reason of at least 3 characters.');
      return;
    }
    void act(action, { note: note.trim() });
  }

  if (!detail) {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white p-4">
        <p className="text-sm text-gray-400">Loading return…</p>
      </div>
    );
  }

  return (
    <aside className="space-y-4">
      <section className="rounded-2xl border border-gray-100 bg-white p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-bold text-ink-900">Return details</h2>
          <button
            onClick={onClose}
            className="text-lg leading-none text-gray-400 hover:text-ink-900"
          >
            ×
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-display text-lg font-bold text-ink-900">{detail.rmaNumber}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STAGE_STYLES[detail.stage]}`}
          >
            {detail.stageLabel}
          </span>
          {detail.disputed && (
            <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
              awaiting admin review
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-gray-400">
          <Link href={`/admin/orders?q=${detail.orderNumber}`} className="text-brand-600">
            {detail.orderNumber}
          </Link>{' '}
          · {when(detail.requestedAt)} · {age(detail.ageHours)} old
        </p>
      </section>

      <Panel title="Item">
        <div className="flex gap-2">
          {detail.item.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={detail.item.imageUrl}
              alt=""
              className="h-16 w-13 shrink-0 rounded border border-gray-200 object-cover"
              style={{ width: '3.25rem' }}
            />
          ) : (
            <div className="h-16 shrink-0 rounded bg-gray-100" style={{ width: '3.25rem' }} />
          )}
          <div className="min-w-0 text-xs">
            <p className="truncate font-medium text-ink-900">{detail.item.title}</p>
            <p className="truncate text-[11px] text-gray-400">
              {detail.item.variantLabel ? ` · ` : ''}{detail.item.sku} · ×{detail.item.quantity}
            </p>
            <p className="mt-1 font-semibold text-ink-900">
              {formatPaise(detail.refundAmountPaise)}
            </p>
            <p className="text-[11px] text-gray-400">{detail.seller.name}</p>
          </div>
        </div>

        <div className="mt-3 rounded-lg bg-cream-50 px-2.5 py-2 text-xs">
          <p className="font-semibold text-ink-900">{detail.reasonLabel}</p>
          {detail.reasonDetail && <p className="mt-0.5 text-gray-600">{detail.reasonDetail}</p>}
        </div>

        {detail.photos.length > 0 && (
          <div className="mt-2 flex gap-2">
            {detail.photos.map((url) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={url}
                alt="Return photo"
                className="h-16 w-16 rounded border border-gray-200 object-cover"
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Timeline">
        <ol className="space-y-2 text-xs">
          {detail.timeline.map((step) => (
            <li key={step.key} className="flex gap-2">
              <span
                className={`mt-1 h-2 w-2 shrink-0 rounded-full ${step.at ? 'bg-brand-600' : 'bg-gray-200'}`}
              />
              <div className="min-w-0">
                <p className={step.at ? 'text-ink-900' : 'text-gray-400'}>{step.label}</p>
                <p className="text-[11px] text-gray-400">
                  {step.at ? when(step.at) : 'not yet'}
                  {step.note ? ` · ${step.note}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="Customer" subtitle="Their return history across the platform">
        <p className="text-sm font-semibold text-ink-900">{detail.customer.name ?? '—'}</p>
        <p className="text-[11px] text-gray-400">
          {detail.customer.email ?? '—'} · +91 {detail.customer.phone}
        </p>
        <dl className="mt-3 space-y-1.5 text-xs">
          {[
            ['Items delivered', num(detail.customerHistory.deliveredItems)],
            ['Returns raised', num(detail.customerHistory.returns)],
            ['Return rate', `${detail.customerHistory.returnRatePercent}%`],
            ['Refunded to date', formatPaise(detail.customerHistory.refundedPaise)],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2">
              <dt className="text-gray-500">{label}</dt>
              <dd
                className={
                  label === 'Return rate' && detail.customerHistory.returnRatePercent >= 50
                    ? 'font-semibold text-red-600'
                    : 'font-semibold text-ink-900'
                }
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      <section className="rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold text-ink-900">Actions</h2>

        {refunding && (
          <div className="mt-3 rounded-xl border border-gray-200 bg-cream-50 p-3">
            <label className={labelClass}>Settle as</label>
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value as ReturnResolutionValue)}
              className={`${inputClass} mt-1`}
            >
              {RETURN_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {RETURN_RESOLUTION_LABELS[r]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-gray-500">
              {resolution === 'STORE_CREDIT'
                ? 'Credits land instantly and never fail — no gateway involved.'
                : 'Goes back to the original payment method through the gateway.'}
            </p>
          </div>
        )}

        {detail.stage === 'IN_TRANSIT' && (
          <div className="mt-3">
            <label className={labelClass}>QC note (optional)</label>
            <input
              value={qcNote}
              onChange={(e) => setQcNote(e.target.value)}
              placeholder="Tags intact, no wear"
              className={`${inputClass} mt-1`}
            />
          </div>
        )}

        <div className="mt-3 grid gap-2 text-xs font-semibold">
          {detail.stage === 'PENDING_REVIEW' && (
            <>
              <button
                disabled={busy}
                onClick={() => void act('APPROVE')}
                className="rounded-lg bg-brand-600 py-2 text-white disabled:opacity-50"
              >
                Approve return
              </button>
              <button
                disabled={busy}
                onClick={() => withNote('REJECT', 'Reason the shopper will see:')}
                className="rounded-lg border border-red-200 py-2 text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Reject return
              </button>
            </>
          )}

          {detail.stage === 'APPROVED' && (
            <button
              disabled={busy}
              onClick={() => void act('MARK_PICKED_UP')}
              className="rounded-lg bg-brand-600 py-2 text-white disabled:opacity-50"
            >
              Mark picked up by courier
            </button>
          )}

          {detail.stage === 'IN_TRANSIT' && (
            <>
              <button
                disabled={busy}
                onClick={() => void act('MARK_RECEIVED', { qcPassed: true, note: qcNote })}
                className="rounded-lg bg-brand-600 py-2 text-white disabled:opacity-50"
              >
                Received — QC passed
              </button>
              <button
                disabled={busy}
                onClick={() => void act('MARK_RECEIVED', { qcPassed: false, note: qcNote })}
                className="rounded-lg border border-red-200 py-2 text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Received — QC failed
              </button>
            </>
          )}

          {detail.stage === 'QC' && detail.qcPassed !== false && (
            <button
              disabled={busy}
              onClick={() => {
                if (!refunding) {
                  setRefunding(true);
                  return;
                }
                void act('REFUND', { resolution });
              }}
              className="rounded-lg bg-brand-600 py-2 text-white disabled:opacity-50"
            >
              {refunding ? `Issue ${RETURN_RESOLUTION_LABELS[resolution]}` : 'Issue refund…'}
            </button>
          )}

          {detail.stage === 'QC' && detail.qcPassed === false && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-700">
              This item failed QC{detail.qcNote ? `: ${detail.qcNote}` : ''}. No refund can be
              issued — resolve it through Support.
            </p>
          )}

          {detail.stage === 'REJECTED' && !detail.adminOverrideAt && (
            <button
              disabled={busy}
              onClick={() => withNote('OVERRIDE', 'Why is the seller decision being overturned?')}
              className="rounded-lg border border-brand-600 py-2 text-brand-600 hover:bg-cream-50 disabled:opacity-50"
            >
              Override rejection &amp; approve
            </button>
          )}

          {detail.stage === 'REJECTED' && detail.adminOverrideAt && (
            <p className="rounded-lg bg-cream-50 px-3 py-2 text-[11px] text-gray-600">
              Reviewed by an admin on {when(detail.adminOverrideAt)}
              {detail.adminOverrideNote ? `: ${detail.adminOverrideNote}` : ''}
            </p>
          )}

          {detail.stage === 'REFUNDED' && (
            <p className="rounded-lg bg-green-50 px-3 py-2 text-[11px] text-green-800">
              Settled as {detail.resolutionLabel.toLowerCase()} —{' '}
              {formatPaise(detail.refundAmountPaise)}.
            </p>
          )}

          <Link
            href="/admin/support"
            className="rounded-lg border border-gray-300 py-2 text-center text-gray-700 hover:bg-gray-50"
          >
            Open support desk
          </Link>
        </div>
      </section>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Return policy
// ---------------------------------------------------------------------------

function PolicyModal({ onClose, flash }: { onClose: () => void; flash: (m: string) => void }) {
  const [policy, setPolicy] = useState<ReturnPolicyView | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      const p = await api<ReturnPolicyView>('/api/admin/returns/meta/policy', { auth: true });
      setPolicy(p);
      setDays(String(p.platformWindowDays));
    })();
  }, []);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/returns/meta/policy', {
        method: 'PATCH',
        auth: true,
        body: { platformWindowDays: Number(days) },
      });
      flash(`Return window set to ${days} days. New return requests use it immediately.`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Return policy" onClose={onClose} wide>
      <p className="text-xs text-gray-500">
        The platform window is the floor. A seller may offer a longer one on their own shop; they
        cannot offer a shorter one. This is enforced when a shopper raises a return, not just
        displayed.
      </p>

      <div className="mt-4 max-w-xs">
        <label className={labelClass}>Platform return window (days)</label>
        <input
          type="number"
          min={1}
          max={90}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className={`${inputClass} mt-1`}
        />
      </div>

      {policy && (
        <div className="mt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Effective window per seller
          </p>
          <div className="mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-gray-500">
                  <th className="px-2 py-1.5 font-semibold">Seller</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Their setting</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Effective</th>
                </tr>
              </thead>
              <tbody>
                {policy.sellers.map((s) => (
                  <tr key={s.id} className="border-t border-gray-100">
                    <td className="px-2 py-1.5 text-ink-900">{s.name}</td>
                    <td className="px-2 py-1.5 text-right text-gray-500">
                      {s.windowDays ?? 'platform default'}
                    </td>
                    <td className="px-2 py-1.5 text-right font-semibold text-ink-900">
                      {s.effectiveDays} days
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={busy || !/^\d+$/.test(days) || Number(days) < 1}
          onClick={() => void save()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save policy'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Manual (goodwill) refund
// ---------------------------------------------------------------------------

interface OrderHit {
  id: string;
  orderNumber: string;
  totalPaise: number;
  customer: { name: string | null; phone: string };
  paymentStatus: string;
  statusLabel: string;
}

function ManualRefundModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<OrderHit[]>([]);
  const [order, setOrder] = useState<OrderHit | null>(null);
  const [rupees, setRupees] = useState('');
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState<ReturnResolutionValue>('REFUND');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 3) {
      setHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const page = await api<{ rows: OrderHit[] }>(
          `/api/admin/orders?q=${encodeURIComponent(q.trim())}&pageSize=5`,
          { auth: true },
        );
        setHits(page.rows);
      } catch {
        setHits([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/returns/manual-refund', {
        method: 'POST',
        auth: true,
        body: {
          orderId: order!.id,
          amountPaise: Math.round(Number(rupees) * 100),
          reason,
          resolution,
        },
      });
      await onDone(
        `${resolution === 'STORE_CREDIT' ? 'Credits' : 'Refund'} of ₹${rupees} issued against ${order!.orderNumber}.`,
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not issue that refund.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create manual refund" onClose={onClose}>
      <p className="text-xs text-gray-500">
        A goodwill refund against an order with no return behind it — a delivery that went wrong, a
        service failure. It is recorded against the order and shows in the payments ledger with your
        reason.
      </p>

      <div className="mt-4">
        <label className={labelClass}>Order</label>
        {order ? (
          <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs">
            <span>
              <strong className="font-mono text-brand-600">{order.orderNumber}</strong>{' '}
              <span className="text-gray-500">
                {order.customer.name ?? `+91 ${order.customer.phone}`} ·{' '}
                {formatPaise(order.totalPaise)} · {order.statusLabel}
              </span>
            </span>
            <button
              onClick={() => {
                setOrder(null);
                setRupees('');
              }}
              className="text-gray-400 hover:text-red-600"
            >
              change
            </button>
          </div>
        ) : (
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by order number, customer or phone…"
              className={`${inputClass} mt-1`}
            />
            {hits.length > 0 && (
              <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-gray-200">
                {hits.map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => {
                        setOrder(h);
                        setRupees(String(Math.round(h.totalPaise / 100)));
                        setHits([]);
                        setQ('');
                      }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-cream-50"
                    >
                      <span className="font-mono text-brand-600">{h.orderNumber}</span>
                      <span className="text-gray-500">
                        {h.customer.name ?? h.customer.phone} · {formatPaise(h.totalPaise)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {order && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Amount (₹)</label>
              <input
                type="number"
                min={1}
                max={Math.round(order.totalPaise / 100)}
                value={rupees}
                onChange={(e) => setRupees(e.target.value)}
                className={`${inputClass} mt-1`}
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Order total {formatPaise(order.totalPaise)}
              </p>
            </div>
            <div>
              <label className={labelClass}>Settle as</label>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value as ReturnResolutionValue)}
                className={`${inputClass} mt-1`}
              >
                {RETURN_RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {RETURN_RESOLUTION_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3">
            <label className={labelClass}>Reason</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Courier lost the parcel — refunded as goodwill"
              className={`${inputClass} mt-1`}
            />
          </div>

          {resolution === 'REFUND' && order.paymentStatus !== 'PAID' && (
            <p className="mt-3 rounded-lg bg-yellow-50 px-3 py-2 text-[11px] text-yellow-800">
              This order was not paid through the gateway, so there is nothing to refund back to.
              Issue Clowe Credits instead.
            </p>
          )}
        </>
      )}

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={busy || !order || !rupees || Number(rupees) < 1 || reason.trim().length < 5}
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Issuing…' : 'Issue refund'}
        </button>
      </div>
    </Modal>
  );
}
