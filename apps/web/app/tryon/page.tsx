'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProductListResponse, TryOnHistoryRow } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import { getPublicSettings } from '@/lib/settings';
import { formatPaise } from '@/lib/format';
import ProductCard from '@/components/ProductCard';

/** Grid of products eligible for Try-On (price ≥ admin threshold). */
function EligibleOutfits() {
  const [minPaise, setMinPaise] = useState<number | null>(null);
  const [products, setProducts] = useState<ProductListResponse['items'] | null>(null);

  useEffect(() => {
    getPublicSettings()
      .then((s) => {
        setMinPaise(s.tryonMinPricePaise);
        const minRupees = Math.ceil(s.tryonMinPricePaise / 100);
        return api<ProductListResponse>(`/api/products?minPrice=${minRupees}&sort=newest`);
      })
      .then((r) => setProducts(r.items))
      .catch(() => setProducts([]));
  }, []);

  if (products === null || products.length === 0) return null;
  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold">Try-On eligible outfits</h2>
        {minPaise !== null && (
          <span className="text-xs text-gray-500">
            ✨ available on products {formatPaise(minPaise)}+
          </span>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {products.slice(0, 8).map((p) => (
          <ProductCard key={p.id} product={p} inWishlist={false} />
        ))}
      </div>
    </section>
  );
}

export default function TryOnHistoryPage() {
  const [rows, setRows] = useState<TryOnHistoryRow[] | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);

  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    api<TryOnHistoryRow[]>('/api/tryon/history', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  if (loggedOut) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">My Try-Ons</p>
        <p className="mt-2 text-sm text-gray-600">
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Login
          </Link>{' '}
          to see your virtual try-ons.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-bold">My Try-Ons ✨</h1>

      {rows === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No try-ons yet. Open any product and hit{' '}
          <span className="font-semibold">✨ Try On Me</span>.{' '}
          <Link href="/products" className="font-semibold text-brand-600 hover:underline">
            Browse products →
          </Link>
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {rows.map((row) => (
            <div key={row.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <div className="relative aspect-[3/4] bg-gray-100">
                {row.resultImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.resultImageUrl} alt={row.productTitle} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-gray-400">
                    {row.status === 'FAILED' ? 'Failed' : 'Processing…'}
                  </div>
                )}
                {row.provider === 'mock' && (
                  <span className="absolute left-2 top-2 rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-semibold text-yellow-700">
                    MOCK
                  </span>
                )}
              </div>
              <div className="p-2.5">
                <Link
                  href={`/products/${row.productSlug}`}
                  className="block truncate text-xs font-semibold hover:text-brand-600"
                >
                  {row.productTitle}
                </Link>
                <p className="mt-0.5 text-[10px] text-gray-400">
                  {new Date(row.createdAt).toLocaleString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <EligibleOutfits />
    </main>
  );
}
