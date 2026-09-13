'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  RETURN_REASONS,
  RETURN_REASON_LABELS,
  RETURN_TABS,
  RETURN_TAB_LABELS,
  SELLER_RETURN_SORTS,
  SELLER_RETURN_SORT_LABELS,
  type ReturnTab,
  type SellerReturnListRow,
  type SellerReturnPage,
  type SellerReturnSort,
  type SellerReturnSummary,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { DonutChart } from '@/components/charts/Charts';

const STATUS_STYLES: Record<string, string> = {
  REQUESTED: 'bg-yellow-100 text-yellow-700',
  APPROVED: 'bg-green-100 text-green-700',
  RECEIVED: 'bg-blue-100 text-blue-700',
  REJECTED: 'bg-red-100 text-red-700',
  REFUNDED: 'bg-green-100 text-green-700',
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
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

export default function SellerReturnsPage() {
  const [tab, setTab] = useState<ReturnTab>('ALL');
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('');
  const [sort, setSort] = useState<SellerReturnSort>('NEWEST');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [data, setData] = useState<SellerReturnPage | null>(null);
  const [summary, setSummary] = useState<SellerReturnSummary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const query = useMemo(() => {
    const params = new URLSearchParams({ tab, sort });
    if (q.trim()) params.set('q', q.trim());
    if (reason) params.set('reason', reason);
    return params.toString();
  }, [tab, sort, q, reason]);

  const loadList = useCallback(async () => {
    try {
      setData(
        await api<SellerReturnPage>(
          `/api/seller/returns?${query}&page=${page}&pageSize=${pageSize}`,
          { auth: true },
        ),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load returns');
      setData(null);
    }
  }, [query, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<SellerReturnSummary>('/api/seller/returns/summary', { auth: true }));
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
  useEffect(() => setSelected(new Set()), [query, page, pageSize]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function decide(row: SellerReturnListRow, action: 'approve' | 'reject' | 'received') {
    let body: Record<string, unknown> = { action };
    if (action === 'reject') {
      const rejectionReason = prompt(`Why are you declining the return of "${row.title}"?`);
      if (!rejectionReason || rejectionReason.trim().length < 5) return;
      body = { action, rejectionReason: rejectionReason.trim() };
    }
    if (action === 'received') {
      const ok = confirm(
        `Did "${row.title}" come back in good condition?\n\nOK = refund the customer.\nCancel = flag it as damaged (no automatic refund).`,
      );
      body = { action, condition: ok ? 'OK' : 'DAMAGED' };
    }

    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/api/seller/returns/${row.id}`, { method: 'PATCH', body, auth: true });
      await Promise.all([loadList(), loadSummary()]);
      setNotice(`${row.reference} updated.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update the return');
    } finally {
      setBusy(false);
    }
  }

  async function bulk(action: 'approve' | 'reject' | 'received') {
    if (selected.size === 0) return;
    let body: Record<string, unknown> = { ids: [...selected], action };
    if (action === 'reject') {
      const rejectionReason = prompt(`Why are you declining these ${selected.size} return(s)?`);
      if (!rejectionReason || rejectionReason.trim().length < 5) return;
      body = { ...body, rejectionReason: rejectionReason.trim() };
    }
    if (action === 'received') {
      body = { ...body, condition: 'OK' };
    }

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ updated: number; skipped: { id: string; reason: string }[] }>(
        '/api/seller/returns/bulk',
        { method: 'POST', body, auth: true },
      );
      setNotice(
        `${result.updated} return(s) updated` +
          (result.skipped.length > 0
            ? ` · ${result.skipped.length} skipped (${result.skipped[0].reason})`
            : ''),
      );
      setSelected(new Set());
      await Promise.all([loadList(), loadSummary()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Bulk action failed');
    } finally {
      setBusy(false);
    }
  }

  const k = summary?.kpis;
  const rows = data?.rows ?? null;

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Returns &amp; Refunds</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Review return requests, approve or decline them, and confirm items received back.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              void downloadFile(`/api/seller/returns/export?${query}`, 'clowe-returns.csv').catch(
                () => setError('Export failed'),
              )
            }
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            ⬇ Export
          </button>
          <Link
            href="/seller/orders"
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            📦 Orders
          </Link>
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
      {summary && summary.policy.overdueCount > 0 && (
        <button
          onClick={() => setTab('REQUESTED')}
          className="mt-4 block w-full rounded-xl border border-yellow-300 bg-yellow-50 px-4 py-2.5 text-left text-sm text-yellow-800"
        >
          ⏰ {summary.policy.overdueCount} request(s) have been waiting over{' '}
          {summary.policy.decisionSlaHours}h for your decision — customers see this as a delay.
        </button>
      )}

      {/* --- KPIs -------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {k ? (
          <>
            <KpiCard
              icon="↩"
              label="Return requests"
              value={String(k.requests)}
              footer={<Delta change={k.requestsChangePercent} invert />}
            />
            <KpiCard
              icon="✅"
              label="Approved"
              value={String(k.approved)}
              footer="Awaiting pickup"
            />
            <KpiCard
              icon="🚚"
              label="Received back"
              value={String(k.inTransit)}
              footer="Checked in at your end"
            />
            <KpiCard
              icon="💰"
              label="Refunded"
              value={String(k.refunded)}
              footer={formatPaise(k.refundedValuePaise)}
            />
            <KpiCard icon="⊗" label="Rejected" value={String(k.rejected)} footer="Declined by you" />
            <KpiCard
              icon="📉"
              label="Return rate"
              value={`${k.returnRate}%`}
              footer={
                k.returnRateChange === null ? (
                  'of units delivered this month'
                ) : (
                  <span className={k.returnRateChange <= 0 ? 'text-green-600' : 'text-red-600'}>
                    {k.returnRateChange >= 0 ? '↑' : '↓'} {Math.abs(k.returnRateChange)} pts vs last
                    month
                  </span>
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

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <div className="xl:col-span-3">
          {/* --- Tabs + filters ------------------------------------------ */}
          <div className="rounded-t-2xl border border-b-0 border-gray-100 bg-white px-3 pt-3">
            <div className="flex flex-wrap gap-1">
              {RETURN_TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded-t-lg px-3 py-2 text-xs font-semibold ${
                    tab === t
                      ? 'border-b-2 border-brand-600 text-brand-600'
                      : 'text-gray-500 hover:text-ink-900'
                  }`}
                >
                  {RETURN_TAB_LABELS[t]}
                  {summary && summary.counts[t] > 0 && (
                    <span className="ml-1 text-gray-400">({summary.counts[t]})</span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 py-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search return ID, order, customer, product…"
                className="min-w-56 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
              />
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
              >
                <option value="">All reasons</option>
                {RETURN_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {RETURN_REASON_LABELS[r]}
                  </option>
                ))}
              </select>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SellerReturnSort)}
                className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
              >
                {SELLER_RETURN_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {SELLER_RETURN_SORT_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* --- Bulk bar ------------------------------------------------- */}
          <div className="flex flex-wrap items-center gap-2 border-x border-gray-100 bg-cream-50 px-3 py-2 text-xs">
            <span className="font-semibold text-ink-900">{selected.size} selected</span>
            <button
              disabled={busy || selected.size === 0}
              onClick={() => void bulk('approve')}
              className="rounded-lg bg-ink-900 px-3 py-1.5 font-semibold text-white hover:bg-ink-800 disabled:opacity-50"
            >
              ✅ Approve
            </button>
            <button
              disabled={busy || selected.size === 0}
              onClick={() => void bulk('reject')}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              ⊗ Reject
            </button>
            <button
              disabled={busy || selected.size === 0}
              onClick={() => void bulk('received')}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              📦 Mark received &amp; refund
            </button>
          </div>

          {/* --- Table --------------------------------------------------- */}
          <div className="overflow-x-auto rounded-b-2xl border border-gray-100 bg-white">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr className="text-left uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={!!rows && rows.length > 0 && selected.size === rows.length}
                      onChange={() =>
                        setSelected((prev) =>
                          rows && prev.size === rows.length
                            ? new Set()
                            : new Set((rows ?? []).map((r) => r.id)),
                        )
                      }
                      className="h-3.5 w-3.5 accent-[#B8860B]"
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-semibold">Return ID</th>
                  <th className="px-3 py-2.5 font-semibold">Order</th>
                  <th className="px-3 py-2.5 font-semibold">Customer</th>
                  <th className="px-3 py-2.5 font-semibold">Product</th>
                  <th className="px-3 py-2.5 font-semibold">Reason</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold">Requested</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Refund</th>
                  <th className="px-3 py-2.5 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 hover:bg-cream-50">
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                        className="h-3.5 w-3.5 accent-[#B8860B]"
                        aria-label={`Select ${row.reference}`}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/seller/returns/${row.id}`}
                        className="font-mono font-semibold text-brand-600 hover:underline"
                      >
                        {row.reference}
                      </Link>
                      {row.adminOverrideAt && (
                        <p className="text-[11px] text-orange-600">Admin override</p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-mono text-gray-700">{row.orderNumber}</p>
                      <p className="text-[11px] text-gray-400">
                        {new Date(row.orderedAt).toLocaleDateString('en-IN')}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-ink-900">{row.customerName}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        {row.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={row.imageUrl}
                            alt=""
                            className="h-10 w-8 rounded border border-gray-200 object-cover"
                          />
                        ) : (
                          <div className="h-10 w-8 rounded bg-cream-100" />
                        )}
                        <div className="min-w-0">
                          <p className="max-w-40 truncate text-ink-900">{row.title}</p>
                          <p className="text-[11px] text-gray-400">
                            {row.variantLabel ? ` · ` : ''}×{row.quantity}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="max-w-40 px-3 py-2.5">
                      <p className="text-gray-700">{row.reasonLabel}</p>
                      {row.details && (
                        <p className="truncate text-[11px] text-gray-400" title={row.details}>
                          {row.details}
                        </p>
                      )}
                      {row.photos.length > 0 && (
                        <p className="text-[11px] text-gray-400">📷 {row.photos.length} photo(s)</p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                          STATUS_STYLES[row.status] ?? 'bg-gray-100 text-gray-600'
                        }`}
                        title={row.rejectionReason ?? undefined}
                      >
                        {row.statusLabel}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                      {fmtDateTime(row.requestedAt)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <p className="font-semibold text-ink-900">
                        {row.refundAmountPaise > 0 ? formatPaise(row.refundAmountPaise) : '—'}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {row.status === 'REJECTED' ? 'Not eligible' : row.refund?.status ?? row.refundRoute}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        {row.canApprove && (
                          <button
                            disabled={busy}
                            onClick={() => void decide(row, 'approve')}
                            title="Approve"
                            className="rounded-lg bg-ink-900 px-2 py-1 text-white hover:bg-ink-800 disabled:opacity-40"
                          >
                            ✓
                          </button>
                        )}
                        {row.canReject && (
                          <button
                            disabled={busy}
                            onClick={() => void decide(row, 'reject')}
                            title="Reject"
                            className="rounded-lg border border-gray-300 px-2 py-1 text-red-600 hover:bg-red-50 disabled:opacity-40"
                          >
                            ✕
                          </button>
                        )}
                        {row.canMarkReceived && (
                          <button
                            disabled={busy}
                            onClick={() => void decide(row, 'received')}
                            title="Mark received & refund"
                            className="rounded-lg bg-brand-600 px-2 py-1 text-white hover:bg-brand-700 disabled:opacity-40"
                          >
                            📦
                          </button>
                        )}
                        <Link
                          href={`/seller/returns/${row.id}`}
                          title="View"
                          className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50"
                        >
                          👁
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows && rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-12 text-center text-gray-500">
                      No returns here. 🎉
                    </td>
                  </tr>
                )}
                {!rows && (
                  <tr>
                    <td colSpan={10} className="px-3 py-12 text-center text-gray-400">
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
                  {Math.min(data.page * data.pageSize, data.total)} of {data.total} returns
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
        </div>

        {/* --- Sidebar --------------------------------------------------- */}
        <div className="space-y-4">
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Return overview</h2>
            {summary && summary.statusBreakdown.length > 0 ? (
              <div className="mt-3">
                <DonutChart
                  slices={summary.statusBreakdown.map((s) => ({
                    key: s.key,
                    label: s.label,
                    count: s.count,
                    share: s.share,
                  }))}
                  total={summary.kpis.requests}
                  totalLabel="RETURNS"
                  size={120}
                />
              </div>
            ) : (
              <p className="mt-3 text-xs text-gray-400">No returns yet.</p>
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Top return reasons</h2>
            {summary && summary.topReasons.length > 0 ? (
              <ul className="mt-3 space-y-2 text-xs">
                {summary.topReasons.map((r) => (
                  <li key={r.key}>
                    <button
                      onClick={() => setReason(r.key)}
                      className="w-full text-left hover:text-brand-600"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-gray-700">{r.label}</span>
                        <span className="font-semibold text-ink-900">
                          {r.count} <span className="text-gray-400">({r.share}%)</span>
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                        <div
                          className="h-full rounded-full bg-brand-600"
                          style={{ width: `${r.share}%` }}
                        />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-400">Nothing returned yet.</p>
            )}
          </section>

          {summary && summary.topProducts.length > 0 && (
            <section className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="text-sm font-bold text-ink-900">Most returned products</h2>
              <p className="text-[11px] text-gray-400">Worth checking sizing or photos</p>
              <ul className="mt-3 space-y-2 text-xs">
                {summary.topProducts.map((p) => (
                  <li key={p.title} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-gray-700">{p.title}</span>
                    <span className="font-semibold text-ink-900">{p.count}</span>
                    <span className="w-16 text-right text-gray-400">
                      {formatPaise(p.valuePaise)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Return policy</h2>
            {summary ? (
              <ul className="mt-3 space-y-2.5 text-xs">
                <li>
                  <p className="font-semibold text-ink-900">🗓 Return window</p>
                  <p className="text-gray-500">
                    {summary.policy.returnWindowDays} days from delivery
                  </p>
                </li>
                <li>
                  <p className="font-semibold text-ink-900">⏱ Refund time</p>
                  <p className="text-gray-500">{summary.policy.refundBusinessDays}</p>
                </li>
                <li>
                  <p className="font-semibold text-ink-900">🚚 Return shipping</p>
                  <p className="text-gray-500">{summary.policy.returnShipping}</p>
                </li>
                <li>
                  <p className="font-semibold text-ink-900">⚖ Decision SLA</p>
                  <p className="text-gray-500">
                    Decide within {summary.policy.decisionSlaHours}h — after that the admin can
                    override on the customer&apos;s behalf.
                  </p>
                </li>
              </ul>
            ) : (
              <div className="mt-3 h-24 animate-pulse rounded-xl bg-gray-100" />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
