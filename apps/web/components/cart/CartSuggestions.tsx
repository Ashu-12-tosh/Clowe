'use client';

import { useEffect, useState } from 'react';
import type { ProductListItem, ProductListResponse } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import ProductCard from '@/components/ProductCard';
import { Scroller } from '@/components/home/HomeBits';

interface Props {
  /** Product ids already in the cart — never suggested back. */
  excludeIds: string[];
  /** Categories the cart is made of; suggestions come from the first one. */
  categorySlug: string | null;
}

/** "You may also like" — a horizontal rail under the cart lines. */
export default function CartSuggestions({ excludeIds, categorySlug }: Props) {
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  const exclude = excludeIds.join(',');
  useEffect(() => {
    const query = categorySlug ? `category=${encodeURIComponent(categorySlug)}&limit=16` : 'limit=16';
    api<ProductListResponse>(`/api/products?${query}`)
      .then((data) => {
        const skip = new Set(exclude ? exclude.split(',') : []);
        setItems(data.items.filter((p) => !skip.has(p.id)).slice(0, 10));
      })
      .catch(() => {});
    fetchWishlistIds().then(setWishlistIds);
  }, [categorySlug, exclude]);

  if (items.length === 0) return null;

  return (
    <section className="mt-5 rounded-2xl border border-gray-100 bg-white p-4">
      <h2 className="text-base font-bold text-ink-900">You may also like</h2>
      <div className="mt-3">
        <Scroller>
          {items.map((product) => (
            <div key={product.id} className="w-40 shrink-0 sm:w-44">
              <ProductCard product={product} inWishlist={wishlistIds.has(product.id)} />
            </div>
          ))}
        </Scroller>
      </div>
    </section>
  );
}
