'use client';

import { useEffect, useState } from 'react';
import type { ProductListItem, ProductListResponse } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import ProductCard from './ProductCard';

interface Props {
  categorySlug: string;
  /** Current product — excluded from the list. */
  excludeId: string;
}

/** "You may also like" — other live products from the same category. */
export default function RelatedProducts({ categorySlug, excludeId }: Props) {
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api<ProductListResponse>(`/api/products?category=${encodeURIComponent(categorySlug)}&limit=9`)
      .then((data) => setItems(data.items.filter((p) => p.id !== excludeId).slice(0, 8)))
      .catch(() => {});
    fetchWishlistIds().then(setWishlistIds);
  }, [categorySlug, excludeId]);

  if (items.length === 0) return null;

  return (
    <section className="mt-10 border-t border-gray-200 pt-6">
      <h2 className="text-lg font-bold">You may also like</h2>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {items.map((product) => (
          <ProductCard key={product.id} product={product} inWishlist={wishlistIds.has(product.id)} />
        ))}
      </div>
    </section>
  );
}
