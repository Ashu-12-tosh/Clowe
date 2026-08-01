'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AD_DURATIONS,
  AD_PLACEMENTS,
  AD_PLACEMENT_LABELS,
  type AdPricing,
  type AdPlacementValue,
  type SellerProductListItem,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

export default function NewAdPage() {
  const router = useRouter();
  const [products, setProducts] = useState<SellerProductListItem[] | null>(null);
  const [pricing, setPricing] = useState<AdPricing | null>(null);
  const [productId, setProductId] = useState('');
  const [placement, setPlacement] = useState<AdPlacementValue>('CATEGORY_SPONSORED');
  const [duration, setDuration] = useState<7 | 15 | 30>(7);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SellerProductListItem[]>('/api/seller/products', { auth: true })
      .then((rows) => setProducts(rows.filter((p) => p.status === 'APPROVED')))
      .catch(() => setProducts([]));
    api<AdPricing>('/api/seller/ads/pricing', { auth: true })
      .then(setPricing)
      .catch(() => {});
  }, []);

  const price = pricing?.[placement]?.[String(duration) as '7' | '15' | '30'] ?? null;

  async function submit() {
    setError('');
    setBusy(true);
    try {
      await api('/api/seller/ads', {
        body: { productId, placement, durationDays: duration },
        auth: true,
      });
      router.push('/seller/ads');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/seller/ads" className="text-xs text-gray-400 hover:text-gray-600">
        ← Advertise
      </Link>
      <h1 className="mt-2 text-2xl font-bold">Create ad request</h1>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* 1. Product */}
      <div className="mt-5 rounded-2xl border border-gray-100 bg-white p-4">
        <p className="text-sm font-semibold text-ink-900">1 · Pick a live product</p>
        {products === null && <p className="mt-2 text-sm text-gray-500">Loading…</p>}
        {products && products.length === 0 && (
          <p className="mt-2 text-sm text-gray-600">
            You need at least one approved (live) product to advertise.
          </p>
        )}
        {products && products.length > 0 && (
          <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
            {products.map((p) => (
              <button
                key={p.id}
                onClick={() => setProductId(p.id)}
                className={`flex items-center gap-3 rounded-xl border p-2.5 text-left transition ${
                  productId === p.id
                    ? 'border-brand-600 bg-brand-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                {p.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.imageUrl} alt="" className="h-12 w-10 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="h-12 w-10 shrink-0 rounded-lg bg-gray-100" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{p.title}</span>
                  <span className="text-xs text-gray-500">{formatPaise(p.minPricePaise)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 2. Placement */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <p className="text-sm font-semibold text-ink-900">2 · Choose placement</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {AD_PLACEMENTS.map((pl) => (
            <button
              key={pl}
              onClick={() => setPlacement(pl)}
              className={`rounded-xl border p-3 text-left text-sm transition ${
                placement === pl ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              {pl === 'HOME_BANNER' ? '🏠 ' : '🏷 '}
              {AD_PLACEMENT_LABELS[pl]}
            </button>
          ))}
        </div>
      </div>

      {/* 3. Duration + price */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <p className="text-sm font-semibold text-ink-900">3 · Duration</p>
        <div className="mt-3 flex gap-2">
          {AD_DURATIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDuration(d)}
              className={`flex-1 rounded-xl border p-3 text-center text-sm transition ${
                duration === d ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              {d} days
              {pricing && (
                <span className="block text-xs text-gray-500">
                  {formatPaise(pricing[placement][String(d) as '7' | '15' | '30'])}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-2xl bg-ink-900 p-4 text-white">
        <div className="flex items-center justify-between">
          <p className="text-sm">Total payable</p>
          <p className="font-display text-2xl font-bold text-brand-400">
            {price !== null ? formatPaise(price) : '—'}
          </p>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Payable manually / adjusted from your seller payouts after approval. Your ad goes live only
          after Clowe review, and always carries a &ldquo;Sponsored&rdquo; label.
        </p>
        <button
          onClick={() => void submit()}
          disabled={busy || !productId}
          className="mt-3 w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'Submit for review'}
        </button>
      </div>
    </div>
  );
}
