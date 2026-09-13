'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  LISTING_STATES,
  LISTING_STATE_LABELS,
  SELLER_PRODUCT_SORTS,
  SELLER_PRODUCT_SORT_LABELS,
  type ListingState,
  type SellerCatalogSummary,
  type SellerProductPage,
  type SellerProductRow,
  type SellerProductSort,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { DonutChart } from '@/components/charts/Charts';

const STATE_STYLES: Record<ListingState, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  INACTIVE: 'bg-gray-100 text-gray-600',
  OUT_OF_STOCK: 'bg-red-100 text-red-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
  DRAFT: 'bg-cream-200 text-ink-900',
  REJECTED: 'bg-red-100 text-red-700',
};

const QUICK_ACTIONS = [
  { href: '/seller/products/new', icon: '＋', label: 'Add new product' },
  { href: '/seller/orders', icon: '📦', label: 'Manage orders' },
  { href: '/seller/ads', icon: '📣', label: 'Advertise products' },
  { href: '/seller/payouts', icon: '₹', label: 'View payouts' },
];

function num(n: number): string {
  return n.toLocaleString('en-IN');
}

function compact(n: number): string {
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
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

export default function SellerProductsPage() {
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [state, setState] = useState<'ALL' | ListingState>('ALL');
  const [sort, setSort] = useState<SellerProductSort>('NEWEST');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [data, setData] = useState<SellerProductPage | null>(null);
  const [summary, setSummary] = useState<SellerCatalogSummary | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (categoryId) params.set('categoryId', categoryId);
    if (state !== 'ALL') params.set('state', state);
    params.set('sort', sort);
    return params.toString();
  }, [q, categoryId, state, sort]);

  const loadList = useCallback(async () => {
    try {
      setData(
        await api<SellerProductPage>(
          `/api/seller/products?${query}&page=${page}&pageSize=${pageSize}`,
          { auth: true },
        ),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load products');
      setData(null);
    }
  }, [query, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<SellerCatalogSummary>('/api/seller/products/summary', { auth: true }));
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

  async function toggleVisibility(row: SellerProductRow) {
    setBusyId(row.id);
    setMenuId(null);
    try {
      const updated = await api<SellerProductRow>(`/api/seller/products/${row.id}/visibility`, {
        method: 'PATCH',
        body: { isVisible: !row.isVisible },
        auth: true,
      });
      setData((prev) =>
        prev ? { ...prev, rows: prev.rows.map((r) => (r.id === row.id ? updated : r)) } : prev,
      );
      void loadSummary();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update the listing');
    } finally {
      setBusyId(null);
    }
  }

  async function archive(row: SellerProductRow) {
    if (!confirm(`Archive "${row.title}"? It is removed from the store and your list.`)) return;
    setBusyId(row.id);
    setMenuId(null);
    try {
      await api(`/api/seller/products/${row.id}`, { method: 'DELETE', auth: true });
      await Promise.all([loadList(), loadSummary()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not archive the product');
    } finally {
      setBusyId(null);
    }
  }

  const k = summary?.kpis;

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Products</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Manage and organise every listing in your shop.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              void downloadFile(`/api/seller/products/export?${query}`, 'clowe-products.csv').catch(
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
            ＋ Add new product
          </Link>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* --- KPIs -------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {k ? (
          <>
            <KpiCard
              icon="👕"
              label="Total products"
              value={num(k.total)}
              footer={<Delta change={k.totalChangePercent} />}
            />
            <KpiCard
              icon="✅"
              label="Active products"
              value={num(k.active)}
              footer={`${k.total > 0 ? Math.round((k.active / k.total) * 100) : 0}% of your catalogue`}
            />
            <KpiCard
              icon="⚠️"
              label="Out of stock"
              value={num(k.outOfStock)}
              footer={k.lowStock > 0 ? `${k.lowStock} more running low` : 'Nothing running low'}
            />
            <KpiCard
              icon="👁"
              label="Views (30 days)"
              value={compact(k.views30d)}
              footer={<Delta change={k.viewsChangePercent} />}
            />
            <KpiCard
              icon="₹"
              label="Total sales"
              value={formatPaise(k.salesPaise)}
              footer={<Delta change={k.salesChangePercent} />}
            />
          </>
        ) : (
          Array.from({ length: 5 }).map((_, i) => (
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
              placeholder="Search by name, SKU, brand, category…"
              className="min-w-56 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
            />
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="max-w-44 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
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
              onChange={(e) => setState(e.target.value as 'ALL' | ListingState)}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
            >
              <option value="ALL">All statuses</option>
              {LISTING_STATES.map((s) => (
                <option key={s} value={s}>
                  {LISTING_STATE_LABELS[s]}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SellerProductSort)}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
            >
              {SELLER_PRODUCT_SORTS.map((s) => (
                <option key={s} value={s}>
                  {SELLER_PRODUCT_SORT_LABELS[s]}
                </option>
              ))}
            </select>
            {(q || categoryId || state !== 'ALL') && (
              <button
                onClick={() => {
                  setQ('');
                  setCategoryId('');
                  setState('ALL');
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
                  <th className="px-3 py-2.5 font-semibold">Product</th>
                  <th className="px-3 py-2.5 font-semibold">SKU</th>
                  <th className="px-3 py-2.5 font-semibold">Category</th>
                  <th className="px-3 py-2.5 font-semibold">Price</th>
                  <th className="px-3 py-2.5 font-semibold">Stock</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Views</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Sales</th>
                  <th className="px-3 py-2.5 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 hover:bg-cream-50">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        {row.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={row.imageUrl}
                            alt=""
                            className="h-11 w-9 rounded-lg border border-gray-200 object-cover"
                          />
                        ) : (
                          <div className="h-11 w-9 rounded-lg bg-cream-100" />
                        )}
                        <div className="min-w-0">
                          <p className="max-w-52 truncate font-medium text-ink-900">{row.title}</p>
                          <p className="max-w-52 truncate text-[11px] text-gray-400">
                            {row.brand ?? row.shortDescription ?? `${row.variantCount} variant(s)`}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-gray-600">{row.sku}</td>
                    <td className="px-3 py-2.5 text-gray-600">{row.categoryName}</td>
                    <td className="px-3 py-2.5">
                      <p className="font-semibold text-ink-900">{formatPaise(row.pricePaise)}</p>
                      {row.mrpPaise && row.mrpPaise > row.pricePaise && (
                        <p className="text-[11px] text-gray-400 line-through">
                          {formatPaise(row.mrpPaise)}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <p
                        className={`font-semibold ${
                          row.totalStock === 0
                            ? 'text-red-600'
                            : row.totalStock <= row.lowStockAlert
                              ? 'text-yellow-600'
                              : 'text-green-700'
                        }`}
                      >
                        {row.totalStock}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {row.totalStock === 0
                          ? 'Out of stock'
                          : row.totalStock <= row.lowStockAlert
                            ? 'Low stock'
                            : 'In stock'}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATE_STYLES[row.listingState]}`}
                        title={row.rejectionReason ?? undefined}
                      >
                        {LISTING_STATE_LABELS[row.listingState]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-gray-600">{compact(row.views)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <p className="font-semibold text-ink-900">{row.unitsSold}</p>
                      <p className="text-[11px] text-gray-400">{formatPaise(row.salesPaise)}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="relative flex items-center gap-1">
                        {row.status === 'APPROVED' ? (
                          <Link
                            href={`/products/${row.slug}`}
                            target="_blank"
                            title="View on storefront"
                            className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50"
                          >
                            👁
                          </Link>
                        ) : (
                          <span
                            title="Not live yet"
                            className="cursor-not-allowed rounded-lg border border-gray-200 px-2 py-1 opacity-40"
                          >
                            👁
                          </span>
                        )}
                        <Link
                          href={`/seller/products/${row.id}/edit`}
                          title="Edit"
                          className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50"
                        >
                          ✎
                        </Link>
                        <button
                          onClick={() => setMenuId(menuId === row.id ? null : row.id)}
                          disabled={busyId === row.id}
                          title="More"
                          className="rounded-lg border border-gray-300 px-2 py-1 hover:bg-gray-50 disabled:opacity-40"
                        >
                          ⋮
                        </button>
                        {menuId === row.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenuId(null)} />
                            <div className="absolute right-0 top-8 z-20 w-52 overflow-hidden rounded-xl border border-gray-100 bg-white py-1 shadow-lg">
                              <button
                                onClick={() => void toggleVisibility(row)}
                                disabled={row.status !== 'APPROVED'}
                                className="block w-full px-3 py-2 text-left hover:bg-cream-50 disabled:opacity-40"
                              >
                                {row.isVisible ? '🚫 Hide from storefront' : '✅ Show on storefront'}
                              </button>
                              <Link
                                href={`/seller/products/${row.id}/edit`}
                                className="block px-3 py-2 hover:bg-cream-50"
                              >
                                ✎ Edit listing
                              </Link>
                              <Link
                                href={`/seller/ads/new?productId=${row.id}`}
                                className="block px-3 py-2 hover:bg-cream-50"
                              >
                                📣 Promote this product
                              </Link>
                              <button
                                onClick={() => void archive(row)}
                                className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50"
                              >
                                🗑 Archive
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-12 text-center text-gray-500">
                      No products match these filters.{' '}
                      <Link href="/seller/products/new" className="font-semibold text-brand-600">
                        Add your first product →
                      </Link>
                    </td>
                  </tr>
                )}
                {!data && (
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
                  {Math.min(data.page * data.pageSize, data.total)} of {data.total} products
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
            <h2 className="text-sm font-bold text-ink-900">Quick actions</h2>
            <ul className="mt-3 space-y-1">
              {QUICK_ACTIONS.map((a) => (
                <li key={a.href}>
                  <Link
                    href={a.href}
                    className="flex items-center gap-2.5 rounded-xl px-2 py-2 text-xs font-medium text-gray-600 hover:bg-cream-50 hover:text-ink-900"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cream-100">
                      {a.icon}
                    </span>
                    {a.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Product status</h2>
            {summary && summary.statusBreakdown.length > 0 ? (
              <div className="mt-3">
                <DonutChart
                  slices={summary.statusBreakdown.map((s) => ({
                    key: s.key,
                    label: s.label,
                    count: s.count,
                    share: s.share,
                  }))}
                  total={summary.kpis.total}
                  totalLabel="LISTINGS"
                  size={120}
                />
              </div>
            ) : (
              <p className="mt-3 text-xs text-gray-400">No products yet.</p>
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Top performing products</h2>
            {summary && summary.topProducts.length > 0 ? (
              <ul className="mt-3 space-y-2.5">
                {summary.topProducts.map((p, i) => (
                  <li key={p.id} className="flex items-center gap-2.5">
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
                      <p className="truncate text-xs font-medium text-ink-900">{p.title}</p>
                      <p className="text-[11px] text-gray-400">{p.unitsSold} sold</p>
                    </div>
                    <span className="text-xs font-semibold text-ink-900">
                      {formatPaise(p.salesPaise)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-400">
                No sales yet — promote a listing to start.
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Need help?</h2>
            <p className="mt-1 text-[11px] text-gray-500">
              Listings with 3+ images, a filled spec sheet and accurate stock convert best.
            </p>
            <Link
              href="/seller/products/new"
              className="mt-3 block rounded-lg border border-gray-300 py-2 text-center text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
            >
              Add a product
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
