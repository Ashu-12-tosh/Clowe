'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SharedWishlist } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import CategoryProductCard from '@/components/category/CategoryProductCard';
import { HeartIcon } from '@/components/cart/CartIcons';

/** Read-only view of a wishlist someone shared by link. */
export default function SharedWishlistPage({ params }: { params: { token: string } }) {
  const [data, setData] = useState<SharedWishlist | null>(null);
  const [gone, setGone] = useState(false);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api<SharedWishlist>(`/api/wishlist/shared/${params.token}`)
      .then(setData)
      .catch(() => setGone(true));
    fetchWishlistIds().then(setWishlistIds);
  }, [params.token]);

  if (gone) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <span className="text-5xl">🔗</span>
        <h1 className="mt-4 font-display text-2xl font-bold text-ink-900">
          This wishlist link is no longer available
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          The owner may have revoked it. Ask them for a fresh link.
        </p>
        <Link
          href="/products"
          className="mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          Browse Clowe
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-10 pt-6">
      <div className="text-center">
        <h1 className="flex items-center justify-center gap-2 font-display text-2xl font-bold text-ink-900 sm:text-3xl">
          <HeartIcon className="h-6 w-6 text-red-500" filled />
          {data ? `${data.ownerName}'s Wishlist` : 'Shared wishlist'}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {data
            ? `${data.items.length} item${data.items.length === 1 ? '' : 's'} · shared with you`
            : 'Loading…'}
        </p>
      </div>

      {data === null ? (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-72 animate-pulse rounded-2xl bg-cream-100" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <p className="mt-12 text-center text-sm text-gray-500">
          This wishlist is empty right now.
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {data.items.map((entry) => (
            <CategoryProductCard
              key={entry.productId}
              product={entry.product}
              inWishlist={wishlistIds.has(entry.productId)}
            />
          ))}
        </div>
      )}
    </main>
  );
}
