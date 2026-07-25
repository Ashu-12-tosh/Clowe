'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProductListItem, ProductListResponse } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import ProductCard from './ProductCard';

/** "Top Picks For You" — latest live products (existing listing API). */
export default function TopPicks() {
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api<ProductListResponse>('/api/products?limit=5')
      .then((data) => setItems(data.items))
      .catch(() => {});
    fetchWishlistIds().then(setWishlistIds);
  }, []);

  if (items.length === 0) return null;

  return (
    <section className="pb-12">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Top Picks For You</h2>
        <Link href="/products" className="text-sm font-semibold text-brand-600 hover:underline">
          View all →
        </Link>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((product) => (
          <ProductCard key={product.id} product={product} inWishlist={wishlistIds.has(product.id)} />
        ))}
      </div>
    </section>
  );
}
