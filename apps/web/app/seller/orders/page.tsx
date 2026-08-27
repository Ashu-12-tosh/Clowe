'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  SELLER_ORDER_SORTS,
  SELLER_ORDER_SORT_LABELS,
  SELLER_ORDER_TAB_LABELS,
  SELLER_PAYMENT_FILTERS,
  type SellerOrderBulkResult,
  type SellerOrderPage,
  type SellerOrderRow,
  type SellerOrderSort,
  type SellerOrderSummary,
  type SellerOrderTab,
  type SellerPaymentFilter,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import OrderDrawer, { StatusPill } from '@/components/seller/orders/OrderDrawer';

const TILE_ICONS: Record<string, string> = {
  NEW: '🆕',
  PACKED: '📦',
  SHIPPED: '🚚',
  DELIVERED: '✅',
  CANCELLED: '⊗',
  RETURNED: '↩',
  REFUNDS: '₹',
};

const PAYMENT_LABELS: Record<SellerPaymentFilter, string> = {
  ALL: 'All payments',
  PAID: 'Prepaid (paid)',
  COD: 'Cash on delivery',
  REFUNDED: 'Refunded',
  PENDING: 'Payment pending',
};

interface Filters {
  tab: SellerOrderTab;
  q: string;
  from: string;
  to: string;
  payment: SellerPaymentFilter;
  sort: SellerOrderSort;
}

const DEFAULT_FILTERS: Filters = {
  tab: 'ALL',
  q: '',
  from: '',
  to: '',
  payment: 'ALL',
  sort: 'NEWEST',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

export default function SellerOrdersPage() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [data, setData] = useState<SellerOrderPage | null>(null);
  const [summary, setSummary] = useState<SellerOrderSummary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [courier, setCourier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value && value !== 'ALL') params.set(key, String(value));
    }
    return params.toString();
  }, [filters]);

  const loadOrders = useCallback(async () => {
    try {
      const body = await api<SellerOrderPage>(
        `/api/seller/orders?${query}&page=${page}&pageSize=${pageSize}`,
        { auth: true },
      );
      setData(body);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load orders');
      setData(null);
    }
  }, [query, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      // Tiles follow the date filter but not the status tab.
      const params = new URLSearchParams();
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      setSummary(
        await api<SellerOrderSummary>(`/api/seller/orders/summary?${params.toString()}`, {
          auth: true,
        }),
      );
    } catch {
      setSummary(null);
    }
  }, [filters.from, filters.to]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);
  useEffect(() => setPage(1), [query, pageSize]);
  useEffect(() => setSelected(new Set()), [query, page, pageSize]);

  function patch(next: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...next }));
  }

  /** Item ids under the current selection of orders. */
  const selectedItemIds = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => selected.has(r.orderId)).flatMap((r) => r.lines.map((l) => l.id));
  }, [data, selected]);

  function toggleOrder(orderId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  function toggleAll() {
    if (!data) return;
    setSelected((prev) =>
      prev.size === data.rows.length ? new Set() : new Set(data.rows.map((r) => r.orderId)),
    );
  }

  async function runBulk(action: 'pack' | 'ship' | 'deliver') {
    if (selectedItemIds.length === 0) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<SellerOrderBulkResult>('/api/seller/orders/bulk', {
        method: 'POST',
        body: { itemIds: selectedItemIds, action, ...(courier ? { courier } : {}) },
        auth: true,
      });
      setNotice(
        `${result.updated} item(s) updated` +
          (result.skipped.length > 0 ? ` · ${result.skipped.length} skipped (${result.skipped[0].reason})` : ''),
      );
      setSelected(new Set());
      await Promise.all([loadOrders(), loadSummary()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Bulk action failed');
    } finally {
      setBusy(false);
    }
  }

  const rows: SellerOrderRow[] | null = data?.rows ?? null;

  return (
    <div className="pb-10">
      {/* --- Header --------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Order Management</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Pack, ship and invoice your customer orders. You only see your own lines of each order.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              void downloadFile(`/api/seller/orders/export?${query}`, 'clowe-orders.csv').catch(() =>
                setError('Export failed'),
              )
            }
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            ⬇ Export orders
          </button>
          <a
            href={`/seller/orders/labels?ids=${selectedItemIds.join(',')}`}
            target="_blank"
            rel="noreferrer"
            aria-disabled={selectedItemIds.length === 0}
            onClick={(e) => selectedItemIds.length === 0 && e.preventDefault()}
            className={`rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold ${
              selectedItemIds.length === 0 ? 'cursor-not-allowed opacity-50' : 'hover:bg-gray-50'
            }`}
          >
            🏷 Print labels{selectedItemIds.length > 0 && ` (${selectedItemIds.length})`}
          </a>
          <Link
            href="/seller/returns"
            className="rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700"
          >
            ↩ Returns desk
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
          {notice}
        </p>
      )}

      {/* --- KPI tiles ------------------------------------------------ */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {summary
          ? summary.tiles.map((tile) => {
              const active = filters.tab === tile.key;
              return (
                <button
                  key={tile.key}
                  onClick={() => patch({ tab: active ? 'ALL' : (tile.key as SellerOrderTab) })}
                  className={`rounded-2xl border bg-white p-3 text-left transition ${
                    active ? 'border-brand-600 ring-1 ring-brand-600' : 'border-gray-100 hover:border-gray-300'
                  }`}
                >
                  <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                    <span>{TILE_ICONS[tile.key]}</span>
                    <span className="truncate">{tile.label}</span>
                  </p>
                  <p className="mt-1 font-display text-xl font-bold text-ink-900">{tile.count}</p>
                  <p className="text-[11px] font-semibold text-brand-600">
                    {formatPaise(tile.valuePaise)}
                  </p>
                </button>
              );
            })
          : Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-gray-100" />
            ))}
      </div>

      {/* --- Filters --------------------------------------------------- */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-100 bg-white p-3">
        <input
          value={filters.q}
          onChange={(e) => patch({ q: e.target.value })}
          placeholder="Search order no., customer, product, AWB…"
          className="min-w-56 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <select
          value={filters.payment}
          onChange={(e) => patch({ payment: e.target.value as SellerPaymentFilter })}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          {SELLER_PAYMENT_FILTERS.map((p) => (
            <option key={p} value={p}>
              {PAYMENT_LABELS[p]}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(e) => patch({ from: e.target.value })}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <span className="text-xs text-gray-400">→</span>
        <input
          type="date"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(e) => patch({ to: e.target.value })}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <select
          value={filters.sort}
          onChange={(e) => patch({ sort: e.target.value as SellerOrderSort })}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          {SELLER_ORDER_SORTS.map((s) => (
            <option key={s} value={s}>
              {SELLER_ORDER_SORT_LABELS[s]}
            </option>
          ))}
        </select>
        <button
          onClick={() => setFilters(DEFAULT_FILTERS)}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-gray-50"
        >
          Reset
        </button>
        {filters.tab !== 'ALL' && (
          <span className="rounded-full bg-ink-900 px-2.5 py-1 text-[11px] font-semibold text-white">
            {SELLER_ORDER_TAB_LABELS[filters.tab]}
            <button onClick={() => patch({ tab: 'ALL' })} className="ml-1.5">
              ✕
            </button>
          </span>
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        {/* --- Table --------------------------------------------------- */}
        <div className="xl:col-span-3">
          {/* Bulk action bar */}
          <div className="flex flex-wrap items-center gap-2 rounded-t-2xl border border-b-0 border-gray-100 bg-cream-50 px-3 py-2.5 text-xs">
            <span className="font-semibold text-ink-900">
              {selected.size} order(s) · {selectedItemIds.length} item(s) selected
            </span>
            <select
              value={courier}
              onChange={(e) => setCourier(e.target.value)}
              disabled={!summary || summary.couriers.length === 0}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 outline-none disabled:opacity-50"
            >
              <option value="">Auto-assign courier</option>
              {summary?.couriers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button
              disabled={busy || selectedItemIds.length === 0}
              onClick={() => void runBulk('pack')}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              📦 Mark packed
            </button>
            <button
              disabled={busy || selectedItemIds.length === 0}
              onClick={() => void runBulk('ship')}
              className="rounded-lg bg-ink-900 px-3 py-1.5 font-semibold text-white hover:bg-ink-800 disabled:opacity-50"
            >
              🚚 Ship &amp; assign courier
            </button>
            <button
              disabled={busy || selectedItemIds.length === 0}
              onClick={() => void runBulk('deliver')}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              ✓ Mark delivered
            </button>
          </div>

          <div className="overflow-x-auto rounded-b-2xl border border-gray-100 bg-white">
            <table className="w-full min-w-[900px] text-xs">
              <thead>
                <tr className="text-left uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={!!rows && rows.length > 0 && selected.size === rows.length}
                      onChange={toggleAll}
                      className="h-3.5 w-3.5 accent-[#B8860B]"
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-semibold">Order</th>
                  <th className="px-3 py-2.5 font-semibold">Customer</th>
                  <th className="px-3 py-2.5 font-semibold">Items</th>
                  <th className="px-3 py-2.5 font-semibold">Amount</th>
                  <th className="px-3 py-2.5 font-semibold">Payment</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold">Order date</th>
                  <th className="px-3 py-2.5 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => (
                  <tr key={row.orderId} className="border-t border-gray-100 hover:bg-cream-50">
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(row.orderId)}
                        onChange={() => toggleOrder(row.orderId)}
                        className="h-3.5 w-3.5 accent-[#B8860B]"
                        aria-label={`Select ${row.orderNumber}`}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => setOpenOrderId(row.orderId)}
                        className="font-mono font-semibold text-brand-600 hover:underline"
                      >
                        {row.orderNumber}
                      </button>
                      <p className="text-[11px] text-gray-400">
                        {row.isGift ? '🎁 Gift · ' : ''}
                        {row.deliveryMethod.replace(/_/g, ' ').toLowerCase()}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-ink-900">{row.customer.name}</p>
                      <p className="text-[11px] text-gray-400">+91 {row.customer.phone}</p>
                      <p className="text-[11px] text-gray-400">
                        {row.shipTo.city}, {row.shipTo.pincode}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        {row.lines.slice(0, 3).map((line) =>
                          line.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              key={line.id}
                              src={line.imageUrl}
                              alt=""
                              title={line.title}
                              className="h-9 w-8 rounded border border-gray-200 object-cover"
                            />
                          ) : (
                            <div key={line.id} className="h-9 w-8 rounded bg-cream-100" />
                          ),
                        )}
                        {row.lines.length > 3 && (
                          <span className="text-[11px] font-semibold text-gray-500">
                            +{row.lines.length - 3}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {row.unitCount} unit{row.unitCount > 1 ? 's' : ''}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-ink-900">
                      {formatPaise(row.amountPaise)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          row.isCod
                            ? 'bg-yellow-100 text-yellow-800'
                            : row.paymentStatus === 'PAID'
                              ? 'bg-green-100 text-green-700'
                              : row.paymentStatus === 'REFUNDED'
                                ? 'bg-gray-100 text-gray-600'
                                : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {row.isCod ? 'COD' : row.paymentStatus === 'PAID' ? 'Paid' : row.paymentStatus}
                      </span>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {row.isCod ? 'Collect on delivery' : 'Prepaid'}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusPill status={row.status} mixed={row.mixedStatus} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                      {fmtDate(row.placedAt)}
                      <span className="block text-[11px] text-gray-400">
                        {fmtTime(row.placedAt)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setOpenOrderId(row.orderId)}
                          title="View order"
                          className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50"
                        >
                          👁
                        </button>
                        <a
                          href={`/seller/orders/labels?ids=${row.lines.map((l) => l.id).join(',')}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Print labels"
                          className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50"
                        >
                          🏷
                        </a>
                        <a
                          href={`/seller/orders/invoice?orderId=${row.orderId}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Generate invoice"
                          className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50"
                        >
                          🧾
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows && rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-12 text-center text-gray-500">
                      No orders match these filters.
                    </td>
                  </tr>
                )}
                {!rows && (
                  <tr>
                    <td colSpan={9} className="px-3 py-12 text-center text-gray-400">
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
                  {Math.min(data.page * data.pageSize, data.total)} of {data.total} orders
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
                    {[10, 25, 50, 100].map((n) => (
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
            <h2 className="text-sm font-bold text-ink-900">Order overview</h2>
            <p className="text-[11px] text-gray-400">
              {filters.from || filters.to ? 'Selected date range' : 'All time'}
            </p>
            {summary ? (
              <dl className="mt-3 space-y-2 text-xs">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Total orders</dt>
                  <dd className="font-semibold text-ink-900">{summary.overview.totalOrders}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Total sales</dt>
                  <dd className="font-semibold text-ink-900">
                    {formatPaise(summary.overview.totalSalesPaise)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Average order value</dt>
                  <dd className="font-semibold text-ink-900">
                    {formatPaise(summary.overview.avgOrderValuePaise)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Return rate</dt>
                  <dd className="font-semibold text-ink-900">{summary.overview.returnRate}%</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Cancelled rate</dt>
                  <dd className="font-semibold text-ink-900">{summary.overview.cancelRate}%</dd>
                </div>
              </dl>
            ) : (
              <div className="mt-3 h-24 animate-pulse rounded-xl bg-gray-100" />
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Shipping actions</h2>
            <ul className="mt-3 space-y-2.5 text-xs">
              <li>
                <a
                  href={`/seller/orders/labels?ids=${selectedItemIds.join(',')}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => selectedItemIds.length === 0 && e.preventDefault()}
                  className={selectedItemIds.length === 0 ? 'cursor-not-allowed opacity-50' : ''}
                >
                  <p className="font-semibold text-ink-900">🏷 Generate shipping labels</p>
                  <p className="text-gray-500">
                    {selectedItemIds.length > 0
                      ? `Print ${selectedItemIds.length} label(s) in bulk`
                      : 'Select orders to print in bulk'}
                  </p>
                </a>
              </li>
              <li>
                <p className="font-semibold text-ink-900">🚚 Assign courier</p>
                <p className="text-gray-500">
                  Pick a courier above, then use “Ship” — {summary?.couriers.length ?? 0} partners
                  available
                </p>
              </li>
              <li>
                <Link href="/track">
                  <p className="font-semibold text-ink-900">📍 Track shipments</p>
                  <p className="text-gray-500">Open the tracking page</p>
                </Link>
              </li>
              <li>
                <button
                  onClick={() =>
                    void downloadFile(
                      `/api/seller/orders/export?${query}&tab=SHIPPED`,
                      'clowe-awb-list.csv',
                    ).catch(() => setError('Download failed'))
                  }
                  className="text-left"
                >
                  <p className="font-semibold text-ink-900">⬇ Download AWB list</p>
                  <p className="text-gray-500">Shipped orders with courier + AWB, as CSV</p>
                </button>
              </li>
            </ul>
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Top couriers</h2>
            {summary && summary.topCouriers.length > 0 ? (
              <ul className="mt-3 space-y-2 text-xs">
                {summary.topCouriers.map((c) => (
                  <li key={c.courier}>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">{c.courier}</span>
                      <span className="font-semibold text-ink-900">
                        {c.count} <span className="text-gray-400">({c.share}%)</span>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                      <div className="h-full rounded-full bg-brand-600" style={{ width: `${c.share}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-400">No shipments booked yet.</p>
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-ink-900">Recent return requests</h2>
              <Link href="/seller/returns" className="text-[11px] font-semibold text-brand-600 hover:underline">
                View all →
              </Link>
            </div>
            {summary && summary.recentRefunds.length > 0 ? (
              <ul className="mt-3 space-y-2 text-xs">
                {summary.recentRefunds.map((r) => (
                  <li key={r.returnId}>
                    <Link href={`/seller/returns/${r.returnId}`} className="block hover:text-brand-600">
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-semibold">{r.orderNumber}</span>
                        <span className="font-semibold text-ink-900">
                          {formatPaise(r.amountPaise)}
                        </span>
                      </div>
                      <p className="truncate text-[11px] text-gray-400">
                        {r.title} · {r.status} · {fmtDate(r.requestedAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-400">No return requests. 🎉</p>
            )}
          </section>
        </div>
      </div>

      {openOrderId && (
        <OrderDrawer
          orderId={openOrderId}
          couriers={summary?.couriers ?? []}
          onClose={() => setOpenOrderId(null)}
          onChanged={() => {
            void loadOrders();
            void loadSummary();
          }}
        />
      )}
    </div>
  );
}
