'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AdminProductDetail, AdminStats } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/** Expanded row: product image + who listed it, loaded on click. */
function TopProductDetail({ productId }: { productId: string }) {
  const [detail, setDetail] = useState<AdminProductDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<AdminProductDetail>(`/api/admin/products/${productId}`, { auth: true })
      .then(setDetail)
      .catch(() => setFailed(true));
  }, [productId]);

  if (failed) return <p className="py-2 text-xs text-red-600">Could not load product details.</p>;
  if (!detail) return <p className="py-2 text-xs text-gray-400">Loading…</p>;

  return (
    <div className="flex gap-3 rounded-lg bg-gray-50 p-3">
      {detail.imageUrls[0] ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={detail.imageUrls[0]} alt={detail.title} className="h-24 w-18 rounded-lg border border-gray-200 object-cover" style={{ width: '4.5rem' }} />
      ) : (
        <div className="h-24 rounded-lg bg-gray-200" style={{ width: '4.5rem' }} />
      )}
      <div className="min-w-0 flex-1 text-xs">
        <p className="text-sm font-semibold">{detail.title}</p>
        <p className="mt-0.5 text-gray-500">
          {detail.brand ?? '—'} · {detail.categoryName} · {detail.variants.length} variants
        </p>
        <p className="mt-1.5">
          <span className="text-gray-500">Listed by:</span>{' '}
          <span className="font-semibold">{detail.seller.shopName}</span>{' '}
          <span className="text-gray-500">· +91 {detail.seller.phone}</span>
          {detail.seller.city && (
            <span className="text-gray-500">
              {' '}· {detail.seller.city}{detail.seller.state ? `, ${detail.seller.state}` : ''}
            </span>
          )}
        </p>
        <div className="mt-2 flex gap-3">
          {detail.status === 'APPROVED' && (
            <Link href={`/products/${detail.slug}`} className="font-semibold text-brand-600 hover:underline">
              View in store →
            </Link>
          )}
          <Link href="/admin/products" className="text-gray-500 hover:underline">
            Manage listing
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState('');
  const [openProductId, setOpenProductId] = useState<string | null>(null);

  useEffect(() => {
    api<AdminStats>('/api/admin/stats', { auth: true })
      .then(setStats)
      .catch(() => setError('Could not load stats (are you logged in as admin?)'));
  }, []);

  if (error) {
    return <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>;
  }

  const cards = stats
    ? [
        { label: 'Total revenue', value: formatPaise(stats.totals.revenuePaise) },
        { label: 'Orders', value: String(stats.totals.orders) },
        { label: 'Units sold', value: String(stats.totals.unitsSold) },
        { label: 'Users', value: String(stats.totals.users) },
        { label: 'Sellers', value: String(stats.totals.sellers) },
        { label: 'Live products', value: `${stats.totals.liveProducts}/${stats.totals.products}` },
      ]
    : [];

  return (
    <div>
      <h1 className="text-2xl font-bold">Platform Dashboard</h1>

      {/* Pending approvals shortcuts */}
      {stats && (stats.pending.sellers > 0 || stats.pending.products > 0) && (
        <div className="mt-4 flex flex-wrap gap-3">
          {stats.pending.sellers > 0 && (
            <Link
              href="/admin/sellers?status=PENDING"
              className="rounded-lg border border-yellow-300 bg-yellow-50 px-4 py-2 text-sm font-medium text-yellow-800 hover:bg-yellow-100"
            >
              ⏳ {stats.pending.sellers} seller application{stats.pending.sellers > 1 ? 's' : ''} waiting
            </Link>
          )}
          {stats.pending.products > 0 && (
            <Link
              href="/admin/products"
              className="rounded-lg border border-yellow-300 bg-yellow-50 px-4 py-2 text-sm font-medium text-yellow-800 hover:bg-yellow-100"
            >
              ⏳ {stats.pending.products} product{stats.pending.products > 1 ? 's' : ''} waiting for approval
            </Link>
          )}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{card.label}</p>
            <p className="mt-1 text-2xl font-bold">{card.value}</p>
          </div>
        ))}
        {!stats &&
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-gray-200" />
          ))}
      </div>

      {stats && (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold">Top 10 products (by units sold)</h2>
            <p className="mt-0.5 text-xs text-gray-400">Click a product to see its image & seller</p>
            {stats.topProducts.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500">No sales yet — arrives with Phase 5 checkout.</p>
            ) : (
              <div className="mt-3">
                {stats.topProducts.map((p, i) => (
                  <div key={p.id} className="border-t border-gray-100">
                    <button
                      onClick={() => setOpenProductId(openProductId === p.id ? null : p.id)}
                      className="flex w-full items-center gap-2 py-2 text-left text-sm hover:bg-gray-50"
                    >
                      <span className="w-6 text-gray-400">{i + 1}.</span>
                      <span className="min-w-0 flex-1 truncate">
                        {p.title}
                        <span className={`ml-1.5 text-xs text-gray-400 transition-transform ${openProductId === p.id ? '' : ''}`}>
                          {openProductId === p.id ? '▴' : '▾'}
                        </span>
                      </span>
                      <span className="whitespace-nowrap text-right">{p.unitsSold} pcs</span>
                      <span className="w-20 whitespace-nowrap text-right font-semibold">
                        {formatPaise(p.revenuePaise)}
                      </span>
                    </button>
                    {openProductId === p.id && (
                      <div className="pb-3">
                        <TopProductDetail productId={p.id} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold">Seller breakdown</h2>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="pb-2">Shop</th>
                  <th className="pb-2 text-right">Live</th>
                  <th className="pb-2 text-right">Sold</th>
                  <th className="pb-2 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {stats.sellerBreakdown.map((s) => (
                  <tr key={s.sellerId} className="border-t border-gray-100">
                    <td className="py-2">
                      {s.shopName}{' '}
                      {s.status !== 'APPROVED' && (
                        <span className="text-xs text-yellow-600">({s.status})</span>
                      )}
                    </td>
                    <td className="py-2 text-right">{s.liveProducts}</td>
                    <td className="py-2 text-right">{s.unitsSold}</td>
                    <td className="py-2 text-right font-semibold">{formatPaise(s.revenuePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
