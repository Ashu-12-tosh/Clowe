'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { AdminProductDetail, AdminProductRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const TABS = ['PENDING', 'APPROVED', 'REJECTED'] as const;

/** Full product review panel, shown when the admin expands a row. */
function ProductReviewPanel({ productId }: { productId: string }) {
  const [detail, setDetail] = useState<AdminProductDetail | null>(null);
  const [error, setError] = useState('');
  const [bigImage, setBigImage] = useState(0);

  useEffect(() => {
    api<AdminProductDetail>(`/api/admin/products/${productId}`, { auth: true })
      .then(setDetail)
      .catch(() => setError('Could not load product details'));
  }, [productId]);

  if (error) return <p className="mt-3 text-sm text-red-600">{error}</p>;
  if (!detail) return <p className="mt-3 text-sm text-gray-500">Loading details…</p>;

  return (
    <div className="mt-4 grid gap-5 border-t border-gray-200 pt-4 lg:grid-cols-[280px,1fr]">
      {/* All images */}
      <div>
        {detail.imageUrls[bigImage] && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={detail.imageUrls[bigImage]}
            alt={detail.title}
            className="aspect-[3/4] w-full rounded-xl border border-gray-100 bg-cream-100 object-cover"
          />
        )}
        {detail.imageUrls.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {detail.imageUrls.map((url, i) => (
              <button
                key={url}
                onClick={() => setBigImage(i)}
                className={`h-16 w-12 overflow-hidden rounded-lg border-2 ${
                  i === bigImage ? 'border-brand-600' : 'border-transparent'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
        <p className="mt-1 text-xs text-gray-400">{detail.imageUrls.length} image(s) uploaded</p>
      </div>

      <div className="min-w-0 space-y-4">
        {/* What the seller filled in */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Product details (as filled by seller)
          </h3>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-gray-500">Title:</dt>
              <dd className="font-medium">{detail.title}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-gray-500">Brand:</dt>
              <dd className="font-medium">{detail.brand ?? '— not given —'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-gray-500">Category:</dt>
              <dd className="font-medium">{detail.categoryName}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-gray-500">Submitted:</dt>
              <dd>{new Date(detail.createdAt).toLocaleString('en-IN')}</dd>
            </div>
          </dl>
          <p className="mt-2 whitespace-pre-line rounded-lg bg-gray-50 p-3 text-sm leading-relaxed text-gray-700">
            {detail.description}
          </p>
        </div>

        {/* Packing video (expires 10 days after upload) */}
        {detail.packingVideoUrl && (
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
              Packing video
            </h3>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={detail.packingVideoUrl}
              controls
              className="mt-2 max-h-56 rounded-lg border border-gray-200 bg-black"
            />
          </div>
        )}

        {/* Variants */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Variants ({detail.variants.length})
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="pb-1 pr-3">SKU</th>
                  <th className="pb-1 pr-3">Options</th>
                  <th className="pb-1 pr-3 text-right">Price</th>
                  <th className="pb-1 pr-3 text-right">MRP</th>
                  <th className="pb-1 text-right">Stock</th>
                </tr>
              </thead>
              <tbody>
                {detail.variants.map((v) => (
                  <tr key={v.sku} className="border-t border-gray-100">
                    <td className="py-1.5 pr-3 font-mono text-xs">{v.sku}</td>
                    <td className="py-1.5 pr-3">{v.label || <span className="text-gray-400">Single SKU</span>}</td>
                    <td className="py-1.5 pr-3 text-right font-medium">{formatPaise(v.pricePaise)}</td>
                    <td className="py-1.5 pr-3 text-right text-gray-500">
                      {v.mrpPaise ? formatPaise(v.mrpPaise) : '—'}
                    </td>
                    <td className="py-1.5 text-right">{v.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Seller info */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">Seller</h3>
          <p className="mt-1 text-sm">
            <span className="font-medium">{detail.seller.shopName}</span>{' '}
            <span
              className={`ml-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                detail.seller.status === 'APPROVED'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-yellow-100 text-yellow-700'
              }`}
            >
              {detail.seller.status}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            +91 {detail.seller.phone}
            {detail.seller.city && ` · ${detail.seller.city}`}
            {detail.seller.state && `, ${detail.seller.state}`}
            {detail.seller.gstNumber && ` · GST: ${detail.seller.gstNumber}`}
            {detail.seller.panNumber && ` · PAN: ${detail.seller.panNumber}`}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AdminProductsPage() {
  const [tab, setTab] = useState<string>('PENDING');
  const [rows, setRows] = useState<AdminProductRow[] | null>(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    setRows(null);
    setOpenId(null);
    api<AdminProductRow[]>(`/api/admin/products?status=${tab}`, { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, [tab]);
  useEffect(load, [load]);

  async function decide(id: string, action: 'approve' | 'reject') {
    setError('');
    let reason: string | undefined;
    if (action === 'reject') {
      reason = window.prompt('Reason for rejection (shown to the seller):') ?? undefined;
      if (reason === undefined) return;
    }
    try {
      await api(`/api/admin/products/${id}`, { method: 'PATCH', body: { action, reason }, auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Product Listings</h1>

      <div className="mt-4 flex gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
              tab === t ? 'bg-ink-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {rows === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && <p className="mt-6 text-sm text-gray-600">Nothing here.</p>}

      <div className="mt-4 space-y-3">
        {rows?.map((p) => (
          <div key={p.id} className="rounded-2xl border border-gray-100 bg-white p-3">
            <div className="flex items-center gap-4">
              {p.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.imageUrl} alt="" className="h-20 w-16 rounded-lg object-cover" />
              ) : (
                <div className="h-20 w-16 rounded-lg bg-gray-100" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{p.title}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {p.brand ?? '—'} · {p.categoryName} · by{' '}
                  <span className="font-medium">{p.shopName}</span> · {p.variantCount} variants ·
                  from {formatPaise(p.minPricePaise)}
                </p>
                {p.rejectionReason && (
                  <p className="mt-0.5 text-xs text-red-600">Reason: {p.rejectionReason}</p>
                )}
                <div className="mt-1 flex gap-3">
                  <button
                    onClick={() => setOpenId(openId === p.id ? null : p.id)}
                    className="text-xs font-semibold text-brand-600 hover:underline"
                  >
                    {openId === p.id ? '▲ Hide details' : '▼ View full details'}
                  </button>
                  {p.status === 'APPROVED' && (
                    <Link
                      href={`/products/${p.slug}`}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      View in store →
                    </Link>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-2">
                {p.status !== 'APPROVED' && (
                  <button
                    onClick={() => void decide(p.id, 'approve')}
                    className="rounded-lg bg-green-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-green-700"
                  >
                    Approve
                  </button>
                )}
                {p.status !== 'REJECTED' && (
                  <button
                    onClick={() => void decide(p.id, 'reject')}
                    className="rounded-lg border border-red-300 px-4 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                  >
                    Reject
                  </button>
                )}
              </div>
            </div>

            {openId === p.id && <ProductReviewPanel productId={p.id} />}
          </div>
        ))}
      </div>
    </div>
  );
}
