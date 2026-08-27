'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ADMIN_ORDER_SORTS,
  ADMIN_ORDER_SORT_LABELS,
  ADMIN_ORDER_STATUSES,
  ADMIN_ORDER_STATUS_LABELS,
  ADMIN_PAYMENT_STATUSES,
  ADMIN_PAYMENT_STATUS_LABELS,
  MANUAL_PAYMENT_METHODS,
  MANUAL_PAYMENT_METHOD_LABELS,
  ORDER_CHANNELS,
  ORDER_CHANNEL_LABELS,
  ORDER_IMPORT_COLUMNS,
  ORDER_TABS,
  ORDER_TAB_LABELS,
  type AdminOrderCustomerHit,
  type AdminOrderDetail,
  type AdminOrderListRow,
  type AdminOrderSort,
  type AdminOrderStatus,
  type AdminOrdersPage,
  type AdminOrdersSummary,
  type AdminPaymentStatus,
  type ManualOrderImportResult,
  type ManualPaymentMethod,
  type OrderChannel,
  type OrderTab,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BarList, DonutChart, LineChart } from '@/components/charts/Charts';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  PLACED: 'bg-yellow-100 text-yellow-800',
  CONFIRMED: 'bg-blue-100 text-blue-700',
  PACKED: 'bg-indigo-100 text-indigo-700',
  SHIPPED: 'bg-purple-100 text-purple-700',
  DELIVERED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-100 text-orange-700',
  RETURNED: 'bg-red-100 text-red-700',
};

const PAYMENT_STYLES: Record<string, string> = {
  PAID: 'bg-green-100 text-green-700',
  CREATED: 'bg-yellow-100 text-yellow-800',
  COD_PENDING: 'bg-orange-100 text-orange-700',
  FAILED: 'bg-red-100 text-red-700',
  REFUNDED: 'bg-purple-100 text-purple-700',
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

function initials(name: string | null, phone: string): string {
  if (name) {
    return name
      .split(' ')
      .slice(0, 2)
      .map((p) => p[0])
      .join('')
      .toUpperCase();
  }
  return phone.slice(-2);
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
  tone?: 'good' | 'warn' | 'bad';
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
      {hint && <p className="mt-2 truncate text-[11px] text-gray-400">{hint}</p>}
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

export default function AdminOrdersPage() {
  const [summary, setSummary] = useState<AdminOrdersSummary | null>(null);
  const [sellers, setSellers] = useState<{ id: string; name: string }[]>([]);
  const [page, setPage] = useState<AdminOrdersPage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [q, setQ] = useState('');
  const [tab, setTab] = useState<OrderTab>('ALL');
  const [paymentStatus, setPaymentStatus] = useState<'ALL' | AdminPaymentStatus>('ALL');
  const [sellerId, setSellerId] = useState('');
  const [channel, setChannel] = useState<'ALL' | OrderChannel>('ALL');
  const [status, setStatus] = useState<'ALL' | AdminOrderStatus>('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [minRupees, setMinRupees] = useState('');
  const [maxRupees, setMaxRupees] = useState('');
  const [moreFilters, setMoreFilters] = useState(false);
  const [sort, setSort] = useState<AdminOrderSort>('NEWEST');
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [openId, setOpenId] = useState<string | null>(null);
  const [modal, setModal] = useState<'CREATE' | 'IMPORT' | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      tab,
      status,
      paymentStatus,
      channel,
      sort,
      page: String(pageNo),
      pageSize: String(pageSize),
    });
    if (q.trim()) params.set('q', q.trim());
    if (sellerId) params.set('sellerId', sellerId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (minRupees) params.set('minPaise', String(Number(minRupees) * 100));
    if (maxRupees) params.set('maxPaise', String(Number(maxRupees) * 100));
    return params.toString();
  }, [
    q,
    tab,
    status,
    paymentStatus,
    channel,
    sellerId,
    from,
    to,
    minRupees,
    maxRupees,
    sort,
    pageNo,
    pageSize,
  ]);

  const loadList = useCallback(async () => {
    try {
      setPage(await api<AdminOrdersPage>(`/api/admin/orders?${query}`, { auth: true }));
      setError('');
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Could not load orders (are you admin?)',
      );
    }
  }, [query]);

  const loadSummary = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([
        api<AdminOrdersSummary>('/api/admin/orders/summary?days=30', { auth: true }),
        api<{ sellers: { id: string; name: string }[] }>('/api/admin/orders/meta/options', {
          auth: true,
        }),
      ]);
      setSummary(s);
      setSellers(o.sellers);
    } catch {
      // The list already surfaces an auth error; a missing summary just leaves
      // the cards empty rather than blocking the table.
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
  }, [q, tab, status, paymentStatus, channel, sellerId, from, to, minRupees, maxRupees, pageSize]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 5000);
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadList(), loadSummary()]);
  }, [loadList, loadSummary]);

  function resetFilters() {
    setQ('');
    setTab('ALL');
    setStatus('ALL');
    setPaymentStatus('ALL');
    setSellerId('');
    setChannel('ALL');
    setFrom('');
    setTo('');
    setMinRupees('');
    setMaxRupees('');
    setSort('NEWEST');
  }

  const rows = page?.rows ?? [];
  const k = summary?.kpis;

  return (
    <div className="pb-10">
      {/* Header ------------------------------------------------------------ */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Order Management</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Every order across every seller — track status, fix problems, place orders by phone.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => downloadFile(`/api/admin/orders/meta/export?${query}`, 'orders.csv')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            ⭳ Export Orders
          </button>
          <button
            onClick={() => setModal('IMPORT')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            ⭱ Import Orders
          </button>
          <button
            onClick={() => setModal('CREATE')}
            className="rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-brand-700"
          >
            + Create Order
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
              icon="🧾"
              label="Total orders"
              value={num(k.total.value)}
              hint={
                k.total.changePercent === null ? (
                  'last 30 days'
                ) : (
                  <span className={k.total.changePercent >= 0 ? 'text-green-600' : 'text-red-600'}>
                    {k.total.changePercent >= 0 ? '↑' : '↓'} {Math.abs(k.total.changePercent)}% vs
                    previous 30d
                  </span>
                )
              }
            />
            <KpiCard
              icon="⏳"
              label="Pending"
              value={num(k.pending)}
              hint="payment not settled"
              tone={k.pending > 0 ? 'warn' : undefined}
            />
            <KpiCard
              icon="⚙"
              label="Processing"
              value={num(k.processing)}
              hint="confirmed or packed"
            />
            <KpiCard icon="🚚" label="Shipped" value={num(k.shipped)} hint="with a courier" />
            <KpiCard icon="✓" label="Delivered" value={num(k.delivered)} hint="last 30 days" />
            <KpiCard
              icon="↩"
              label="Returned"
              value={num(k.returned)}
              hint={`${num(k.cancelled)} cancelled`}
              tone={k.returned > 0 ? 'bad' : undefined}
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
          placeholder="Search by order ID, customer, email, phone…"
          className="min-w-64 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs outline-none focus:border-brand-600"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as 'ALL' | AdminOrderStatus)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="ALL">All status</option>
          {ADMIN_ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ADMIN_ORDER_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          value={paymentStatus}
          onChange={(e) => setPaymentStatus(e.target.value as 'ALL' | AdminPaymentStatus)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="ALL">All payment status</option>
          {ADMIN_PAYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ADMIN_PAYMENT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          value={sellerId}
          onChange={(e) => setSellerId(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="">All sellers</option>
          {sellers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as 'ALL' | OrderChannel)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="ALL">All channels</option>
          {ORDER_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {ORDER_CHANNEL_LABELS[c]}
            </option>
          ))}
        </select>
        <button
          onClick={() => setMoreFilters((v) => !v)}
          className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
            moreFilters ? 'border-brand-600 text-brand-600' : 'border-gray-300 text-gray-700'
          }`}
        >
          ⚙ More filters
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
            <label className={labelClass}>Placed from</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className={labelClass}>Placed to</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className={labelClass}>Min amount (₹)</label>
            <input
              type="number"
              min={0}
              value={minRupees}
              onChange={(e) => setMinRupees(e.target.value)}
              className="mt-1 w-28 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className={labelClass}>Max amount (₹)</label>
            <input
              type="number"
              min={0}
              value={maxRupees}
              onChange={(e) => setMaxRupees(e.target.value)}
              className="mt-1 w-28 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
            />
          </div>
        </div>
      )}

      {/* Table + drawer ---------------------------------------------------- */}
      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <div className={openId ? 'xl:col-span-3' : 'xl:col-span-4'}>
          <section className="rounded-2xl border border-gray-100 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <div className="flex gap-1 overflow-x-auto">
                {ORDER_TABS.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold ${
                      tab === t ? 'bg-cream-100 text-brand-600' : 'text-gray-500 hover:text-ink-900'
                    }`}
                  >
                    {ORDER_TAB_LABELS[t]}
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
                onChange={(e) => setSort(e.target.value as AdminOrderSort)}
                className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
              >
                {ADMIN_ORDER_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {ADMIN_ORDER_SORT_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-xs">
                <thead>
                  <tr className="text-left uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2.5 font-semibold">Order ID</th>
                    <th className="px-3 py-2.5 font-semibold">Customer</th>
                    <th className="px-3 py-2.5 font-semibold">Items</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Amount</th>
                    <th className="px-3 py-2.5 font-semibold">Payment</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th>
                    <th className="px-3 py-2.5 font-semibold">Seller</th>
                    <th className="px-3 py-2.5 font-semibold">Date</th>
                    <th className="px-3 py-2.5 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <OrderRow
                      key={o.id}
                      order={o}
                      active={openId === o.id}
                      onOpen={() => setOpenId(openId === o.id ? null : o.id)}
                    />
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-4 py-14 text-center text-gray-500">
                        No orders match those filters.
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
                  {(page.page - 1) * page.pageSize + rows.length} of {num(page.total)} orders
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

        {openId && (
          <OrderDrawer
            orderId={openId}
            onClose={() => setOpenId(null)}
            flash={flash}
            onChanged={refreshAll}
          />
        )}
      </div>

      {/* Charts ------------------------------------------------------------ */}
      {summary && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-5">
          <div className="xl:col-span-2">
            <Panel title="Order trend" subtitle="Last 30 days">
              <LineChart
                points={summary.trend.map((t) => ({ date: t.date, value: t.orders }))}
                height={150}
              />
              <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                Revenue
              </p>
              <LineChart
                points={summary.trend.map((t) => ({ date: t.date, value: t.revenuePaise }))}
                color="#141414"
                format={shortMoney}
                height={90}
              />
            </Panel>
          </div>

          <Panel title="Order status distribution" subtitle="Last 30 days">
            <DonutChart
              slices={summary.statusDistribution}
              total={summary.statusDistribution.reduce((sum, s) => sum + s.count, 0)}
              totalLabel="ORDERS"
              size={120}
            />
          </Panel>

          <Panel title="Payment status" subtitle="Last 30 days">
            <DonutChart
              slices={summary.paymentDistribution}
              total={summary.paymentDistribution.reduce((sum, s) => sum + s.count, 0)}
              totalLabel="ORDERS"
              size={120}
            />
          </Panel>

          <div className="space-y-4">
            <Panel title="Top sellers by orders" subtitle="Last 30 days">
              <BarList
                numbered
                items={summary.topSellers.map((s) => ({
                  key: s.id,
                  label: s.name,
                  percent:
                    (summary.topSellers[0]?.orders ?? 0) > 0
                      ? (s.orders / summary.topSellers[0]!.orders) * 100
                      : 0,
                  value: num(s.orders),
                  hint: formatPaise(s.revenuePaise),
                }))}
              />
            </Panel>

            <Panel title="Average order value" subtitle="Last 30 days">
              <p className="font-display text-2xl font-bold text-ink-900">
                {formatPaise(summary.kpis.averageOrderValuePaise)}
              </p>
              <p className="mt-1 text-[11px]">
                {summary.kpis.averageOrderValueChangePercent === null ? (
                  <span className="text-gray-400">no prior period</span>
                ) : (
                  <span
                    className={
                      summary.kpis.averageOrderValueChangePercent >= 0
                        ? 'text-green-600'
                        : 'text-red-600'
                    }
                  >
                    {summary.kpis.averageOrderValueChangePercent >= 0 ? '↑' : '↓'}{' '}
                    {Math.abs(summary.kpis.averageOrderValueChangePercent)}%{' '}
                    <span className="text-gray-400">vs previous 30d</span>
                  </span>
                )}
              </p>
              <p className="mt-2 text-[11px] text-gray-400">
                Across {formatPaise(summary.kpis.revenuePaise)} of orders that were not cancelled or
                returned.
              </p>
            </Panel>
          </div>
        </div>
      )}

      {modal === 'CREATE' && (
        <CreateOrderModal
          onClose={() => setModal(null)}
          onDone={async (message) => {
            setModal(null);
            flash(message);
            await refreshAll();
          }}
        />
      )}
      {modal === 'IMPORT' && (
        <ImportOrdersModal
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

function OrderRow({
  order,
  active,
  onOpen,
}: {
  order: AdminOrderListRow;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <tr className={`border-t border-gray-100 ${active ? 'bg-cream-50' : 'hover:bg-cream-50'}`}>
      <td className="px-3 py-2.5">
        <span className="font-mono text-brand-600">{order.orderNumber}</span>
        {order.channel === 'ADMIN' && (
          <span className="ml-1 rounded-full bg-cream-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">
            phone
          </span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cream-100 text-[10px] font-bold text-gray-600">
            {initials(order.customer.name, order.customer.phone)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium text-ink-900">{order.customer.name ?? '—'}</p>
            <p className="truncate text-[11px] text-gray-400">
              {order.customer.email ?? `+91 ${order.customer.phone}`}
            </p>
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1">
          {order.itemThumbnails.map((url) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt=""
              className="h-7 w-7 rounded border border-gray-200 object-cover"
            />
          ))}
          {order.itemCount > order.itemThumbnails.length && (
            <span className="text-[11px] text-gray-400">
              +{order.itemCount - order.itemThumbnails.length}
            </span>
          )}
          {order.itemThumbnails.length === 0 && (
            <span className="text-[11px] text-gray-400">{order.itemCount} item(s)</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-right font-semibold text-ink-900">
        {formatPaise(order.totalPaise)}
      </td>
      <td className="px-3 py-2.5">
        <span
          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            PAYMENT_STYLES[order.paymentStatus] ?? 'bg-gray-100 text-gray-600'
          }`}
        >
          {order.paymentStatus === 'COD_PENDING' ? 'COD' : order.paymentStatusLabel}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <span
          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            STATUS_STYLES[order.status] ?? 'bg-gray-100 text-gray-600'
          }`}
        >
          {order.statusLabel}
        </span>
      </td>
      <td className="max-w-40 truncate px-3 py-2.5 text-gray-600">
        {order.sellerNames.join(', ') || '—'}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">{when(order.createdAt)}</td>
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

const NEXT_STATUS: Record<string, AdminOrderStatus | null> = {
  PLACED: 'CONFIRMED',
  CONFIRMED: 'PACKED',
  PACKED: 'SHIPPED',
  SHIPPED: 'DELIVERED',
  DELIVERED: null,
};

function OrderDrawer({
  orderId,
  onClose,
  flash,
  onChanged,
}: {
  orderId: string;
  onClose: () => void;
  flash: (m: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [awb, setAwb] = useState('');
  const [courier, setCourier] = useState('');

  const load = useCallback(async () => {
    setDetail(await api<AdminOrderDetail>(`/api/admin/orders/${orderId}`, { auth: true }));
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function advance(status: AdminOrderStatus) {
    setBusy(true);
    try {
      await api(`/api/admin/orders/${orderId}/status`, {
        method: 'PATCH',
        auth: true,
        body: {
          status,
          ...(status === 'SHIPPED' ? { trackingNumber: awb, courier } : {}),
        },
      });
      flash(`Order moved to ${ADMIN_ORDER_STATUS_LABELS[status]}.`);
      setShipping(false);
      setAwb('');
      setCourier('');
      await load();
      await onChanged();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not update that order.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const reason = window.prompt('Why is this order being cancelled?');
    if (reason === null) return;
    if (reason.trim().length < 3) {
      flash('Give a reason of at least 3 characters.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/admin/orders/${orderId}/cancel`, {
        method: 'POST',
        auth: true,
        body: { reason: reason.trim() },
      });
      flash('Order cancelled — stock returned and the customer notified.');
      await load();
      await onChanged();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not cancel that order.');
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white p-4">
        <p className="text-sm text-gray-400">Loading order…</p>
      </div>
    );
  }

  const next = NEXT_STATUS[detail.status];
  const closed = ['CANCELLED', 'RETURNED'].includes(detail.status);

  return (
    <aside className="space-y-4">
      <section className="rounded-2xl border border-gray-100 bg-white p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-bold text-ink-900">Order details</h2>
          <button
            onClick={onClose}
            className="text-lg leading-none text-gray-400 hover:text-ink-900"
          >
            ×
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-display text-lg font-bold text-ink-900">{detail.orderNumber}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              STATUS_STYLES[detail.status] ?? 'bg-gray-100 text-gray-600'
            }`}
          >
            {detail.statusLabel}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-gray-400">
          {when(detail.createdAt)} · {ORDER_CHANNEL_LABELS[detail.channel]}
          {detail.placedByAdminName ? ` (${detail.placedByAdminName})` : ''}
        </p>
        {detail.adminNote && (
          <p className="mt-2 rounded-lg bg-cream-50 px-2.5 py-1.5 text-[11px] text-gray-600">
            {detail.adminNote}
          </p>
        )}
      </section>

      <Panel
        title="Customer"
        action={
          <Link
            href={`/admin/users?q=${encodeURIComponent(detail.customer.phone)}`}
            className="text-[11px] font-semibold text-brand-600"
          >
            View profile →
          </Link>
        }
      >
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-100 text-xs font-bold text-gray-600">
            {initials(detail.customer.name, detail.customer.phone)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-900">
              {detail.customer.name ?? '—'}
            </p>
            <p className="truncate text-[11px] text-gray-400">
              {detail.customer.email ?? '—'} · +91 {detail.customer.phone}
            </p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-gray-500">
          {num(detail.customer.orderCount)} order(s) ·{' '}
          {formatPaise(detail.customer.lifetimeValuePaise)} lifetime
        </p>
      </Panel>

      <Panel title="Items" subtitle={`${detail.items.length} line(s)`}>
        <ul className="space-y-2.5">
          {detail.items.map((i) => (
            <li key={i.id} className="flex gap-2 text-xs">
              {i.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={i.imageUrl}
                  alt=""
                  className="h-12 w-10 shrink-0 rounded border border-gray-200 object-cover"
                />
              ) : (
                <div className="h-12 w-10 shrink-0 rounded bg-gray-100" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink-900">{i.title}</p>
                <p className="truncate text-[11px] text-gray-400">
                  {i.size} / {i.color} · {i.sellerName}
                </p>
                <p className="mt-0.5">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      STATUS_STYLES[i.status] ?? 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {i.statusLabel}
                  </span>
                  {i.returnStatus && (
                    <span className="ml-1 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700">
                      return {i.returnStatus.toLowerCase()}
                    </span>
                  )}
                  {i.trackingNumber && (
                    <span className="ml-1 text-[10px] text-gray-400">
                      {i.courier ?? 'AWB'} {i.trackingNumber}
                    </span>
                  )}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-semibold text-ink-900">
                  {formatPaise(i.pricePaise * i.quantity)}
                </p>
                <p className="text-[11px] text-gray-400">× {i.quantity}</p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Order summary">
        <dl className="space-y-1.5 text-xs">
          {[
            ['Items total', formatPaise(detail.summary.itemsTotalPaise), ''],
            ['Shipping', formatPaise(detail.summary.shippingPaise), ''],
            ...(detail.summary.discountPaise > 0
              ? [['Discount', `− ${formatPaise(detail.summary.discountPaise)}`, 'text-red-600']]
              : []),
            ...(detail.summary.couponCode
              ? [
                  [
                    `Coupon ${detail.summary.couponCode}`,
                    `− ${formatPaise(detail.summary.couponDiscountPaise)}`,
                    'text-red-600',
                  ],
                ]
              : []),
            ...(detail.summary.creditsUsed > 0
              ? [['Credits used', `${num(detail.summary.creditsUsed)} credits`, 'text-gray-500']]
              : []),
            ['GST (included)', formatPaise(detail.summary.taxPaise), 'text-gray-500'],
          ].map(([label, value, cls]) => (
            <div key={String(label)} className="flex justify-between gap-2">
              <dt className="text-gray-500">{label as string}</dt>
              <dd className={(cls as string) || 'text-ink-900'}>{value as string}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-2 border-t border-gray-100 pt-2">
            <dt className="font-semibold text-ink-900">Order total</dt>
            <dd className="font-display font-bold text-brand-600">
              {formatPaise(detail.summary.totalPaise)}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Payment info">
        <dl className="space-y-1.5 text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">Method</dt>
            <dd className="text-ink-900">
              {detail.payment.method}
              {detail.payment.provider ? ` (${detail.payment.provider})` : ''}
            </dd>
          </div>
          {detail.payment.providerPaymentId && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Transaction ID</dt>
              <dd className="truncate font-mono text-ink-900">
                {detail.payment.providerPaymentId}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">Payment status</dt>
            <dd>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  PAYMENT_STYLES[detail.payment.status] ?? 'bg-gray-100 text-gray-600'
                }`}
              >
                {detail.payment.statusLabel}
              </span>
            </dd>
          </div>
          {detail.payment.paidAt && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Paid on</dt>
              <dd className="text-ink-900">{when(detail.payment.paidAt)}</dd>
            </div>
          )}
          {detail.payment.refundedPaise > 0 && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Refunded</dt>
              <dd className="font-semibold text-purple-700">
                {formatPaise(detail.payment.refundedPaise)}
              </dd>
            </div>
          )}
          {detail.payment.failureReason && (
            <p className="rounded-lg bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {detail.payment.failureReason}
            </p>
          )}
        </dl>
      </Panel>

      <Panel title="Delivery">
        <p className="text-xs text-ink-900">{detail.shipping.name}</p>
        <p className="text-[11px] text-gray-500">
          {detail.shipping.line1}
          {detail.shipping.line2 ? `, ${detail.shipping.line2}` : ''}, {detail.shipping.city},{' '}
          {detail.shipping.state} — {detail.shipping.pincode}
        </p>
        <p className="mt-1 text-[11px] text-gray-400">
          +91 {detail.shipping.phone} · {detail.shipping.method}
          {detail.shipping.etaFrom &&
            ` · ETA ${new Date(detail.shipping.etaFrom).toLocaleDateString('en-IN')}`}
        </p>
        {detail.isGift && (
          <p className="mt-2 rounded-lg bg-cream-50 px-2.5 py-1.5 text-[11px] text-gray-600">
            🎁 Gift{detail.giftMessage ? `: “${detail.giftMessage}”` : ''}
          </p>
        )}
      </Panel>

      {detail.complaints.length > 0 && (
        <Panel title="Support tickets">
          <ul className="space-y-1.5 text-xs">
            {detail.complaints.map((c) => (
              <li key={c.id}>
                <Link href="/admin/support" className="hover:text-brand-600">
                  <span className="font-mono text-brand-600">{c.reference}</span> — {c.subject}{' '}
                  <span className="text-gray-400">({c.status.toLowerCase()})</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <section className="rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold text-ink-900">Actions</h2>

        {shipping && (
          <div className="mt-3 space-y-2 rounded-xl border border-gray-200 bg-cream-50 p-3">
            <div>
              <label className={labelClass}>Courier</label>
              <input
                value={courier}
                onChange={(e) => setCourier(e.target.value)}
                placeholder="Delhivery"
                className={`${inputClass} mt-1`}
              />
            </div>
            <div>
              <label className={labelClass}>AWB / tracking number</label>
              <input
                value={awb}
                onChange={(e) => setAwb(e.target.value)}
                className={`${inputClass} mt-1`}
              />
            </div>
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-semibold">
          {next && !closed && (
            <button
              disabled={busy}
              onClick={() => {
                if (next === 'SHIPPED' && !shipping) {
                  setShipping(true);
                  return;
                }
                void advance(next);
              }}
              className="col-span-2 rounded-lg bg-brand-600 py-2 text-white disabled:opacity-50"
            >
              {next === 'SHIPPED' && !shipping
                ? 'Mark shipped…'
                : `Move to ${ADMIN_ORDER_STATUS_LABELS[next]}`}
            </button>
          )}
          <button
            onClick={() =>
              flash('Tax invoices are issued per seller — open the order in the seller dashboard.')
            }
            className="rounded-lg border border-gray-300 py-2 text-center text-gray-700 hover:bg-gray-50"
          >
            View invoice
          </button>
          <Link
            href="/admin/returns"
            className="rounded-lg border border-gray-300 py-2 text-center text-gray-700 hover:bg-gray-50"
          >
            Refund / return
          </Link>
          {!closed && (
            <button
              disabled={busy}
              onClick={() => void cancel()}
              className="col-span-2 rounded-lg border border-red-200 py-2 text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Cancel order
            </button>
          )}
        </div>

        {closed && (
          <p className="mt-2 text-[11px] text-gray-400">
            This order is {detail.statusLabel.toLowerCase()} — nothing left to move.
          </p>
        )}
      </section>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Create order (phone order)
// ---------------------------------------------------------------------------

interface VariantHit {
  id: string;
  sku: string;
  title: string;
  size: string;
  color: string;
  pricePaise: number;
  totalStock: number;
}

function CreateOrderModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [customerQuery, setCustomerQuery] = useState('');
  const [hits, setHits] = useState<AdminOrderCustomerHit[]>([]);
  const [customer, setCustomer] = useState<AdminOrderCustomerHit | null>(null);
  const [addressId, setAddressId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<ManualPaymentMethod>('COD');
  const [deliveryMethod, setDeliveryMethod] = useState<'STANDARD' | 'EXPRESS'>('STANDARD');
  const [adminNote, setAdminNote] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const [productHits, setProductHits] = useState<VariantHit[]>([]);
  const [lines, setLines] = useState<{ variant: VariantHit; quantity: number }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (customerQuery.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        setHits(
          await api<AdminOrderCustomerHit[]>(
            `/api/admin/orders/meta/customers?q=${encodeURIComponent(customerQuery.trim())}`,
            { auth: true },
          ),
        );
      } catch {
        setHits([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [customerQuery]);

  useEffect(() => {
    if (productQuery.trim().length < 2) {
      setProductHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        setProductHits(
          await api<VariantHit[]>(
            `/api/admin/inventory/meta/variants?q=${encodeURIComponent(productQuery.trim())}`,
            { auth: true },
          ),
        );
      } catch {
        setProductHits([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [productQuery]);

  const subtotal = lines.reduce((sum, l) => sum + l.variant.pricePaise * l.quantity, 0);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const created = await api<{ orderNumber: string; totalPaise: number }>(
        '/api/admin/orders/manual',
        {
          method: 'POST',
          auth: true,
          body: {
            userId: customer!.id,
            addressId,
            paymentMethod,
            deliveryMethod,
            adminNote,
            items: lines.map((l) => ({ variantId: l.variant.id, quantity: l.quantity })),
          },
        },
      );
      await onDone(
        `${created.orderNumber} placed for ${customer!.name ?? customer!.phone} — ${formatPaise(created.totalPaise)}.`,
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not place that order.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create order" onClose={onClose} wide>
      <p className="text-xs text-gray-500">
        A phone order placed for a shopper. It reserves stock, notifies the seller and raises the
        payout exactly like a storefront checkout — coupons, credits and seller promotions are not
        applied, so the shopper pays list price.
      </p>

      {/* Customer -------------------------------------------------------- */}
      <div className="mt-4">
        <label className={labelClass}>Customer</label>
        {customer ? (
          <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs">
            <span>
              <strong className="text-ink-900">{customer.name ?? 'Unnamed'}</strong>{' '}
              <span className="text-gray-400">
                +91 {customer.phone}
                {customer.email ? ` · ${customer.email}` : ''}
              </span>
            </span>
            <button
              onClick={() => {
                setCustomer(null);
                setAddressId('');
              }}
              className="text-gray-400 hover:text-red-600"
            >
              change
            </button>
          </div>
        ) : (
          <>
            <input
              value={customerQuery}
              onChange={(e) => setCustomerQuery(e.target.value)}
              placeholder="Search by name, email or phone…"
              className={`${inputClass} mt-1`}
            />
            {hits.length > 0 && (
              <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-gray-200">
                {hits.map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => {
                        setCustomer(h);
                        setAddressId(h.addresses[0]?.id ?? '');
                        setHits([]);
                        setCustomerQuery('');
                      }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-cream-50"
                    >
                      <span className="text-ink-900">{h.name ?? 'Unnamed'}</span>
                      <span className="text-gray-400">
                        +91 {h.phone} · {h.addresses.length} address(es)
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {customer && (
        <div className="mt-3">
          <label className={labelClass}>Deliver to</label>
          {customer.addresses.length === 0 ? (
            <p className="mt-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              This customer has no saved address. They need to add one before an order can be placed
              for them.
            </p>
          ) : (
            <select
              value={addressId}
              onChange={(e) => setAddressId(e.target.value)}
              className={`${inputClass} mt-1`}
            >
              {customer.addresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} — {a.line1}, {a.city} {a.pincode}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Items ------------------------------------------------------------ */}
      <div className="mt-4">
        <label className={labelClass}>Items</label>
        <input
          value={productQuery}
          onChange={(e) => setProductQuery(e.target.value)}
          placeholder="Search a SKU or product…"
          className={`${inputClass} mt-1`}
        />
        {productHits.length > 0 && (
          <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-gray-200">
            {productHits.map((h) => (
              <li key={h.id}>
                <button
                  onClick={() => {
                    setLines((ls) =>
                      ls.some((l) => l.variant.id === h.id)
                        ? ls
                        : [...ls, { variant: h, quantity: 1 }],
                    );
                    setProductQuery('');
                    setProductHits([]);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-cream-50"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-brand-600">{h.sku}</span> {h.title}
                    <span className="text-gray-400">
                      {' '}
                      · {h.size}/{h.color}
                    </span>
                  </span>
                  <span className="shrink-0 text-gray-500">
                    {formatPaise(h.pricePaise)} · {h.totalStock} left
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {lines.length > 0 && (
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 font-semibold">SKU</th>
              <th className="py-1 font-semibold">Product</th>
              <th className="py-1 text-right font-semibold">Price</th>
              <th className="py-1 text-right font-semibold">Qty</th>
              <th className="py-1 text-right font-semibold">Line</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.variant.id} className="border-t border-gray-100">
                <td className="py-1.5 font-mono text-brand-600">{l.variant.sku}</td>
                <td className="max-w-44 truncate py-1.5">{l.variant.title}</td>
                <td className="py-1.5 text-right">{formatPaise(l.variant.pricePaise)}</td>
                <td className="py-1.5 text-right">
                  <input
                    type="number"
                    min={1}
                    max={l.variant.totalStock}
                    value={l.quantity}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x, j) =>
                          j === i ? { ...x, quantity: Number(e.target.value) } : x,
                        ),
                      )
                    }
                    className="w-16 rounded border border-gray-300 px-2 py-1 text-right"
                  />
                </td>
                <td className="py-1.5 text-right font-semibold">
                  {formatPaise(l.variant.pricePaise * l.quantity)}
                </td>
                <td className="py-1.5 text-right">
                  <button
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                    className="text-gray-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
            <tr className="border-t border-gray-200">
              <td colSpan={4} className="py-2 text-right font-semibold text-gray-500">
                Subtotal
              </td>
              <td className="py-2 text-right font-display font-bold text-ink-900">
                {formatPaise(subtotal)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Payment</label>
          <select
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as ManualPaymentMethod)}
            className={`${inputClass} mt-1`}
          >
            {MANUAL_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {MANUAL_PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Delivery</label>
          <select
            value={deliveryMethod}
            onChange={(e) => setDeliveryMethod(e.target.value as 'STANDARD' | 'EXPRESS')}
            className={`${inputClass} mt-1`}
          >
            <option value="STANDARD">Standard</option>
            <option value="EXPRESS">Express</option>
          </select>
        </div>
      </div>

      <div className="mt-3">
        <label className={labelClass}>Note (why this was placed manually)</label>
        <input
          value={adminNote}
          onChange={(e) => setAdminNote(e.target.value)}
          placeholder="Phone order taken by support"
          className={`${inputClass} mt-1`}
        />
      </div>

      {paymentMethod !== 'COD' && (
        <p className="mt-3 rounded-lg bg-yellow-50 px-3 py-2 text-[11px] text-yellow-800">
          Choosing {MANUAL_PAYMENT_METHOD_LABELS[paymentMethod]} records the order as already paid.
          Only pick this once the money has actually landed — it releases the seller payout.
        </p>
      )}

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={
            busy ||
            !customer ||
            !addressId ||
            lines.length === 0 ||
            lines.some((l) => l.quantity < 1 || l.quantity > l.variant.totalStock)
          }
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Placing…' : 'Place order'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Import orders (bulk phone orders)
// ---------------------------------------------------------------------------

interface ParsedOrderRow {
  line: number;
  phone: string;
  sku: string;
  quantity: number;
  paymentMethod: ManualPaymentMethod;
  note?: string;
  error?: string;
}

/** Minimal CSV reader: handles quoted cells and escaped double quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function ImportOrdersModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [rows, setRows] = useState<ParsedOrderRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ManualOrderImportResult | null>(null);

  function readFile(file: File) {
    setError('');
    setResult(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const table = parseCsv(String(reader.result ?? ''));
      if (table.length < 2) {
        setError('That file has a header but no rows.');
        setRows(null);
        return;
      }
      const header = table[0]!.map((h) => h.trim().toLowerCase());
      const col = (name: string) => header.findIndex((h) => h === name.toLowerCase());
      const phoneAt = col('customer phone');
      const skuAt = col('sku');
      const qtyAt = col('quantity');
      const payAt = col('payment method');
      const noteAt = col('note');

      if (phoneAt < 0 || skuAt < 0 || qtyAt < 0) {
        setError(`The header must include ${ORDER_IMPORT_COLUMNS.slice(0, 3).join(', ')}.`);
        setRows(null);
        return;
      }

      setRows(
        table.slice(1).map((cells, i) => {
          const phone = (cells[phoneAt] ?? '').trim().replace(/\D/g, '').slice(-10);
          const sku = (cells[skuAt] ?? '').trim();
          const rawQty = (cells[qtyAt] ?? '').trim();
          const rawPay = payAt >= 0 ? (cells[payAt] ?? '').trim().toUpperCase() : '';
          const note = noteAt >= 0 ? (cells[noteAt] ?? '').trim() : '';
          const known = (MANUAL_PAYMENT_METHODS as readonly string[]).includes(rawPay);

          const row: ParsedOrderRow = {
            line: i + 2,
            phone,
            sku,
            quantity: Number(rawQty),
            paymentMethod: known ? (rawPay as ManualPaymentMethod) : 'COD',
            note: note || undefined,
          };
          if (phone.length !== 10) row.error = 'Phone must be 10 digits';
          else if (!sku) row.error = 'Missing SKU';
          else if (!/^\d+$/.test(rawQty) || row.quantity < 1) {
            row.error = 'Quantity must be 1 or more';
          } else if (rawPay && !known) row.error = `Unknown payment method ${rawPay}`;
          return row;
        }),
      );
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(file);
  }

  function downloadTemplate() {
    const csv = `${ORDER_IMPORT_COLUMNS.join(',')}\n9100000001,CLW-000001,1,COD,Phone order\n`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'order-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const valid = (rows ?? []).filter((r) => !r.error);
  const invalid = (rows ?? []).filter((r) => r.error);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const body = await api<ManualOrderImportResult>('/api/admin/orders/manual/import', {
        method: 'POST',
        auth: true,
        body: {
          rows: valid.map((r) => ({
            phone: r.phone,
            sku: r.sku,
            quantity: r.quantity,
            paymentMethod: r.paymentMethod,
            ...(r.note ? { note: r.note } : {}),
          })),
        },
      });
      setResult(body);
      if (body.skipped.length === 0) {
        await onDone(`${num(body.created.length)} order(s) placed.`);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not import those orders.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Import orders" onClose={onClose} wide>
      <div className="rounded-xl border border-yellow-300 bg-yellow-50 px-3 py-2 text-[11px] text-yellow-800">
        This places <strong>new</strong> phone orders — one per row. Each one reserves stock,
        notifies the seller and raises a payout, exactly like a storefront checkout. It is not a
        migration tool: importing orders that already shipped somewhere else would double-count
        revenue and take stock that was never on the shelf.
      </div>

      <p className="mt-3 text-xs text-gray-500">
        Columns: <strong>{ORDER_IMPORT_COLUMNS.join(', ')}</strong>. The customer must already exist
        and have a saved address; the order goes to their first address.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) readFile(file);
          }}
          className="text-xs"
        />
        <button
          onClick={downloadTemplate}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
        >
          Download template
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      {rows && (
        <>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full bg-cream-100 px-2.5 py-1 font-semibold text-ink-900">
              {fileName}
            </span>
            <span className="rounded-full bg-green-100 px-2.5 py-1 font-semibold text-green-700">
              {num(valid.length)} ready
            </span>
            {invalid.length > 0 && (
              <span className="rounded-full bg-red-100 px-2.5 py-1 font-semibold text-red-700">
                {num(invalid.length)} will be skipped
              </span>
            )}
          </div>

          <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-gray-200">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-gray-500">
                  <th className="px-2 py-1.5 font-semibold">Line</th>
                  <th className="px-2 py-1.5 font-semibold">Phone</th>
                  <th className="px-2 py-1.5 font-semibold">SKU</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                  <th className="px-2 py-1.5 font-semibold">Payment</th>
                  <th className="px-2 py-1.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map((r) => (
                  <tr key={r.line} className="border-t border-gray-100">
                    <td className="px-2 py-1 text-gray-400">{r.line}</td>
                    <td className="px-2 py-1">{r.phone || '—'}</td>
                    <td className="px-2 py-1 font-mono text-brand-600">{r.sku || '—'}</td>
                    <td className="px-2 py-1 text-right">
                      {Number.isFinite(r.quantity) ? r.quantity : '—'}
                    </td>
                    <td className="px-2 py-1 text-gray-600">{r.paymentMethod}</td>
                    <td className="px-2 py-1">
                      {r.error ? (
                        <span className="text-red-600">{r.error}</span>
                      ) : (
                        <span className="text-green-600">Ready</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {result && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-cream-50 p-3 text-xs">
          <p className="font-semibold text-ink-900">
            {num(result.created.length)} order(s) placed
            {result.skipped.length > 0 ? `, ${num(result.skipped.length)} skipped` : ''}
          </p>
          {result.created.length > 0 && (
            <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto text-[11px] text-gray-600">
              {result.created.map((c) => (
                <li key={c.orderNumber}>
                  <span className="font-mono text-brand-600">{c.orderNumber}</span> — {c.phone} ·{' '}
                  {formatPaise(c.totalPaise)}
                </li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto text-[11px] text-red-600">
              {result.skipped.map((s) => (
                <li key={`${s.row}-${s.phone}`}>
                  Row {s.row} ({s.phone}): {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          {result ? 'Close' : 'Cancel'}
        </button>
        <button
          disabled={busy || valid.length === 0 || Boolean(result)}
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Placing…' : `Place ${num(valid.length)} order(s)`}
        </button>
      </div>
    </Modal>
  );
}
