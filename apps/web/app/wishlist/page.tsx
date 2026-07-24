'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { WishlistEntry } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import ProductCard from '@/components/ProductCard';

export default function WishlistPage() {
  const [items, setItems] = useState<WishlistEntry[] | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);

  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    api<WishlistEntry[]>('/api/wishlist', { auth: true })
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <h1 className="text-2xl font-bold">My Wishlist</h1>

      {loggedOut && (
        <p className="mt-6 text-sm text-gray-600">
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Login
          </Link>{' '}
          to see your wishlist.
        </p>
      )}

      {items && items.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          Your wishlist is empty.{' '}
          <Link href="/products" className="font-semibold text-brand-600 hover:underline">
            Start shopping →
          </Link>
        </p>
      )}

      {items && items.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {items.map((entry) => (
            <ProductCard
              key={entry.productId}
              product={entry.product}
              inWishlist
              onRemovedFromWishlist={() =>
                setItems((prev) => prev?.filter((i) => i.productId !== entry.productId) ?? null)
              }
            />
          ))}
        </div>
      )}
    </main>
  );
}
