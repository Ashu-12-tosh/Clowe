'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  INVENTORY_SORTS,
  INVENTORY_SORT_LABELS,
  STOCK_STATES,
  STOCK_STATE_LABELS,
  type InventoryPage,
  type InventoryRow,
  type InventorySort,
  type InventorySummary,
  type StockState,
  type StockUpdateResult,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { DonutChart } from '@/components/charts/Charts';

const STATE_STYLES: Record<StockState, string> = {
  IN_STOCK: 'bg-green-100 text-green-700',
  LOW_STOCK: 'bg-yellow-100 text-yellow-700',
  OUT_OF_STOCK: 'bg-red-100 text-red-700',
};

function num(n: number): string {
  return n.toLocaleString('en-IN');
}

function compact(n: number): string {
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function KpiCard({
  icon,
  label,
  value,
  footer,
  onClick,
  active,
}: {
  icon: string;
  label: string;
  value: string;
  footer: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`rounded-2xl border bg-white p-4 text-left transition ${
        active ? 'border-brand-600 ring-1 ring-brand-600' : 'border-gray-100'
      } ${onClick ? 'hover:border-gray-300' : 'cursor-default'}`}
    >
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
    </button>
  );
}

export default function SellerInventoryPage() {
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [state, setState] = useState<'ALL' | StockState>('ALL');
  const [sort, setSort] = useState<InventorySort>('STOCK_LOW');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [data, setData] = useState<InventoryPage | null>(null);
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkValue, setBulkValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const query = useMemo(() => {
    const p = new URLSearchParams({ sort });
    if (q.trim()) p.set('q', q.trim());
    if (categoryId) p.set('categoryId', categoryId);
    if (state !== 'ALL') p.set('state', state);
    return p.toString();
  }, [q, categoryId, state, sort]);

  const loadList = useCallback(async () => {
    try {
      setData(
        await api<InventoryPage>(`/api/seller/inventory?${query}&page=${page}&pageSize=${pageSize}`, {
          auth: true,
        }),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load inventory');
      setData(null);
    }
  }, [query, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<InventorySummary>('/api/seller/inventory/summary', { auth: true }));
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
  useEffect(() => {
    setSelected(new Set());
    setEdits({});
  }, [query, page, pageSize]);

  /** Push a set of stock changes and merge the fresh rows back into the table. */
  async function pushUpdates(updates: { variantId: string; stock?: number; delta?: number }[]) {
    if (updates.length === 0) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<StockUpdateResult>('/api/seller/inventory/stock', {
        method: 'PATCH',
        body: { updates },
        auth: true,
      });
      const byId = new Map(result.rows.map((r) => [r.variantId, r]));
      setData((prev) =>
        prev
          ? { ...prev, rows: prev.rows.map((r) => byId.get(r.variantId) ?? r) }
          : prev,
      );
      setNotice(
        `${result.updated} variant(s) updated` +
          (result.skipped.length > 0 ? ` · ${result.skipped.length} skipped` : ''),
      );
      void loadSummary();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update stock');
    } finally {
      setBusy(false);
    }
  }

  async function saveRow(row: InventoryRow) {
    const raw = edits[row.variantId];
    if (raw === undefined || raw === '') return;
    const stock = Math.max(0, Math.round(Number(raw) || 0));
    if (stock === row.stock) {
      setEdits((prev) => {
        const next = { ...prev };
        delete next[row.variantId];
        return next;
      });
      return;
    }
    await pushUpdates([{ variantId: row.variantId, stock }]);
    setEdits((prev) => {
      const next = { ...prev };
      delete next[row.variantId];
      return next;
    });
  }

  async function bulkSet(mode: 'SET' | 'ADD' | 'SUB') {
    const value = Math.round(Number(bulkValue) || 0);
    if (selected.size === 0 || (mode === 'SET' && bulkValue === '') || (mode !== 'SET' && value === 0))
      return;
    const updates = [...selected].map((variantId) =>
      mode === 'SET'
        ? { variantId, stock: Math.max(0, value) }
        : { variantId, delta: mode === 'ADD' ? value : -value },
    );
    await pushUpdates(updates);
    setSelected(new Set());
    setBulkValue('');
  }

  const k = summary?.kpis;
  const rows = data?.rows ?? null;

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Inventory</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Stock lives on each size/colour — edit a count inline or update many at once.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              void downloadFile(`/api/seller/inventory/export?${query}`, 'clowe-inventory.csv').catch(
                () => setError('Export failed'),
              )
            }
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            ⬇ Export
          </button>
          <Link
            href="/seller/products/new"
            className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700"
          >
            ＋ Add product
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
      {k && k.outOfStock > 0 && (
        <button
          onClick={() => setState('OUT_OF_STOCK')}
          className="mt-4 block w-full rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-left text-sm text-red-700"
        >
          ⚠ {k.outOfStock} variant(s) are out of stock and cannot be sold right now.
        </button>
      )}

      {/* --- KPIs -------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {k ? (
          <>
            <KpiCard
              icon="📦"
              label="Sellable units"
              value={num(k.totalUnits)}
              footer={`${num(k.variants)} variants across ${num(k.products)} products`}
            />
            <KpiCard
              icon="✅"
              label="In stock"
              value={num(k.inStock)}
              footer="Comfortably above threshold"
              onClick={() => setState('IN_STOCK')}
              active={state === 'IN_STOCK'}
            />
            <KpiCard
              icon="⚠️"
              label="Low stock"
              value={num(k.lowStock)}
              footer="At or below your alert level"
              onClick={() => setState('LOW_STOCK')}
              active={state === 'LOW_STOCK'}
            />
            <KpiCard
              icon="⛔"
              label="Out of stock"
              value={num(k.outOfStock)}
              footer="Losing sales right now"
              onClick={() => setState('OUT_OF_STOCK')}
              active={state === 'OUT_OF_STOCK'}
            />
            <KpiCard
              icon="₹"
              label="Stock value"
              value={formatPaise(k.stockValuePaise)}
              footer="At your selling price"
            />
            <KpiCard
              icon="🔒"
              label="Reserved"
              value={num(k.reservedUnits)}
              footer="Committed to orders not yet shipped"
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
              placeholder="Search SKU, product, size or colour…"
              className="min-w-56 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
            />
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="max-w-40 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
            >
              <option value="">All categories</option>
              {summary?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.count})
                </option>
              ))}
            </select>
            <select
              value={state}
              onChange={(e) => setState(e.target.value as 'ALL' | StockState)}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
            >
              <option value="ALL">All stock states</option>
              {STOCK_STATES.map((s) => (
                <option key={s} value={s}>
                  {STOCK_STATE_LABELS[s]}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as InventorySort)}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
            >
              {INVENTORY_SORTS.map((s) => (
                <option key={s} value={s}>
                  {INVENTORY_SORT_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          {/* --- Bulk stock bar ------------------------------------------ */}
          <div className="flex flex-wrap items-center gap-2 border-x border-gray-100 bg-cream-50 px-3 py-2 text-xs">
            <span className="font-semibold text-ink-900">{selected.size} selected</span>
            <input
              type="number"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              placeholder="Qty"
              className="w-20 rounded-lg border border-gray-300 px-2 py-1 outline-none focus:border-brand-600"
            />
            <button
              disabled={busy || selected.size === 0 || bulkValue === ''}
              onClick={() => void bulkSet('SET')}
              className="rounded-lg bg-ink-900 px-3 py-1.5 font-semibold text-white hover:bg-ink-800 disabled:opacity-50"
            >
              Set to
            </button>
            <button
              disabled={busy || selected.size === 0 || bulkValue === ''}
              onClick={() => void bulkSet('ADD')}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              ＋ Add
            </button>
            <button
              disabled={busy || selected.size === 0 || bulkValue === ''}
              onClick={() => void bulkSet('SUB')}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              − Remove
            </button>
            <span className="text-[11px] text-gray-500">
              Adjustments never take a variant below zero.
            </span>
          </div>

          {/* --- Table --------------------------------------------------- */}
          <div className="overflow-x-auto rounded-b-2xl border border-gray-100 bg-white">
            <table className="w-full min-w-[900px] text-xs">
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
                            : new Set((rows ?? []).map((r) => r.variantId)),
                        )
                      }
                      className="h-3.5 w-3.5 accent-[#B8860B]"
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-semibold">Product</th>
                  <th className="px-3 py-2.5 font-semibold">SKU</th>
                  <th className="px-3 py-2.5 font-semibold">Variant</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Price</th>
                  <th className="px-3 py-2.5 font-semibold">Stock</th>
                  <th className="px-3 py-2.5 font-semibold">State</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Sold</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Stock value</th>
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => {
                  const draft = edits[row.variantId];
                  const dirty = draft !== undefined && Number(draft) !== row.stock;
                  return (
                    <tr key={row.variantId} className="border-t border-gray-100 hover:bg-cream-50">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selected.has(row.variantId)}
                          onChange={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(row.variantId)) next.delete(row.variantId);
                              else next.add(row.variantId);
                              return next;
                            })
                          }
                          className="h-3.5 w-3.5 accent-[#B8860B]"
                          aria-label={`Select ${row.sku}`}
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
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
                            <Link
                              href={`/seller/products/${row.productId}/edit`}
                              className="block max-w-44 truncate font-medium text-ink-900 hover:text-brand-600"
                            >
                              {row.title}
                            </Link>
                            <p className="text-[11px] text-gray-400">
                              {row.categoryName}
                              {!row.isVisible && ' · hidden'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-gray-600">{row.sku}</td>
                      <td className="px-3 py-2.5 text-gray-600">
                        {row.color} / {row.size}
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold text-ink-900">
                        {formatPaise(row.pricePaise)}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            value={draft ?? String(row.stock)}
                            onChange={(e) =>
                              setEdits((prev) => ({ ...prev, [row.variantId]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveRow(row);
                            }}
                            className={`w-16 rounded-lg border px-2 py-1 outline-none ${
                              dirty ? 'border-brand-600' : 'border-gray-300'
                            }`}
                          />
                          {dirty && (
                            <button
                              disabled={busy}
                              onClick={() => void saveRow(row)}
                              className="rounded-lg bg-ink-900 px-2 py-1 font-semibold text-white hover:bg-ink-800 disabled:opacity-50"
                            >
                              Save
                            </button>
                          )}
                        </div>
                        {row.reservedUnits > 0 && (
                          <p className="mt-0.5 text-[11px] text-gray-400">
                            {row.reservedUnits} reserved
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATE_STYLES[row.stockState]}`}
                          title={`Alert at ${row.lowStockAlert}`}
                        >
                          {row.stockStateLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-600">{row.unitsSold}</td>
                      <td className="px-3 py-2.5 text-right text-gray-600">
                        {formatPaise(row.stockValuePaise)}
                      </td>
                    </tr>
                  );
                })}
                {rows && rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-12 text-center text-gray-500">
                      No variants match these filters.
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
                  {Math.min(data.page * data.pageSize, data.total)} of {data.total} variants
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
                    {[20, 50, 100].map((n) => (
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
            <h2 className="text-sm font-bold text-ink-900">Inventory overview</h2>
            {summary && summary.stockBreakdown.length > 0 ? (
              <div className="mt-3">
                <DonutChart
                  slices={summary.stockBreakdown.map((s) => ({
                    key: s.key,
                    label: s.label,
                    count: s.count,
                    share: s.share,
                  }))}
                  total={summary.kpis.variants}
                  totalLabel="VARIANTS"
                  size={120}
                />
              </div>
            ) : (
              <p className="mt-3 text-xs text-gray-400">Nothing in stock yet.</p>
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Restock first</h2>
            <p className="text-[11px] text-gray-400">Out of stock, then closest to running out</p>
            {summary && summary.restockList.length > 0 ? (
              <ul className="mt-3 space-y-2 text-xs">
                {summary.restockList.map((r) => (
                  <li key={r.variantId} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-ink-900">{r.title}</p>
                      <p className="text-[11px] text-gray-400">
                        {r.color} / {r.size} · {r.unitsSold} sold
                      </p>
                    </div>
                    <span
                      className={`shrink-0 font-semibold ${r.stock === 0 ? 'text-red-600' : 'text-yellow-600'}`}
                    >
                      {r.stock}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-400">Everything is comfortably stocked. 🎉</p>
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Top sellers</h2>
            {summary && summary.topSellers.length > 0 ? (
              <ul className="mt-3 space-y-2.5 text-xs">
                {summary.topSellers.map((p, i) => (
                  <li key={p.productId} className="flex items-center gap-2.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-100 text-[10px] font-bold text-gray-500">
                      {i + 1}
                    </span>
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.imageUrl}
                        alt=""
                        className="h-9 w-8 rounded border border-gray-200 object-cover"
                      />
                    ) : (
                      <div className="h-9 w-8 rounded bg-cream-100" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ink-900">{p.title}</p>
                      <p className="text-[11px] text-gray-400">
                        {p.unitsSold} sold · {p.stock} left
                      </p>
                    </div>
                    <span className="font-semibold text-ink-900">{formatPaise(p.salesPaise)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-400">No sales yet.</p>
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Performance</h2>
            <p className="text-[11px] text-gray-400">Last 30 days</p>
            {summary ? (
              <dl className="mt-3 space-y-2 text-xs">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Product views</dt>
                  <dd className="font-semibold text-ink-900">
                    {compact(summary.performance.views30d)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Units sold</dt>
                  <dd className="font-semibold text-ink-900">
                    {num(summary.performance.unitsSold30d)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Views → orders</dt>
                  <dd className="font-semibold text-ink-900">
                    {summary.performance.conversionRate}%
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Average order</dt>
                  <dd className="font-semibold text-ink-900">
                    {formatPaise(summary.performance.avgOrderValuePaise)}
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="mt-3 h-24 animate-pulse rounded-xl bg-gray-100" />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
