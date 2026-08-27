'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProductListItem } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import CategoryProductCard from '@/components/category/CategoryProductCard';

export default function RecentlyViewedPage() {
  const [items, setItems] = useState<ProductListItem[] | null>(null);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api<ProductListItem[]>('/api/me/recently-viewed?limit=24', { auth: true })
      .then(setItems)
      .catch(() => setItems([]));
    fetchWishlistIds().then(setWishlistIds);
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Recently Viewed</h1>
        <p className="mt-1 text-sm text-gray-500">
          Products you opened recently, newest first.
        </p>
      </div>

      {items === null ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-72 animate-pulse rounded-2xl bg-cream-100" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white py-12 text-center">
          <span className="text-4xl">🕘</span>
          <p className="mt-3 text-sm text-gray-500">Nothing here yet — go browse something.</p>
          <Link
            href="/products"
            className="mt-4 inline-block rounded-lg bg-ink-900 px-6 py-2.5 text-sm font-bold text-white hover:bg-ink-800"
          >
            Start Shopping
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {items.map((product) => (
            <CategoryProductCard
              key={product.id}
              product={product}
              inWishlist={wishlistIds.has(product.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
