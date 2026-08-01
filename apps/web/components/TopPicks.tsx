'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProductListItem, ProductListResponse } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import ProductCard from './ProductCard';
import { trackAdClick, useSponsoredAds } from './SponsoredAds';

/** "Top Picks For You" — latest live products, with sponsored cards inline. */
export default function TopPicks() {
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());
  const ads = useSponsoredAds('HOME_BANNER');

  useEffect(() => {
    api<ProductListResponse>('/api/products?limit=5')
      .then((data) => setItems(data.items))
      .catch(() => {});
    fetchWishlistIds().then(setWishlistIds);
  }, []);

  // Sponsored products lead the grid; skip organic duplicates of the same product.
  const adProductIds = new Set(ads.map((ad) => ad.product.id));
  const organic = items.filter((p) => !adProductIds.has(p.id));

  if (organic.length === 0 && ads.length === 0) return null;

  return (
    <section className="pb-12">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Top Picks For You</h2>
        <Link href="/products" className="text-sm font-semibold text-brand-600 hover:underline">
          View all →
        </Link>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {ads.map((ad) => (
          <ProductCard
            key={`ad-${ad.id}`}
            product={ad.product}
            inWishlist={wishlistIds.has(ad.product.id)}
            sponsored
            onNavigate={() => trackAdClick(ad.id)}
          />
        ))}
        {organic.map((product) => (
          <ProductCard key={product.id} product={product} inWishlist={wishlistIds.has(product.id)} />
        ))}
      </div>
    </section>
  );
}
