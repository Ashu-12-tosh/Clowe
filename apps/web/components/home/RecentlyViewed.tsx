'use client';

// "Recently viewed" rail for the bottom of the landing page.
//
// Ids come from this browser (so it works logged out, like Amazon's), and for
// a signed-in shopper the server's own view history is appended behind them —
// that covers products looked at on another device. Renders nothing at all
// until there is something to show, so a first-time visitor sees no gap.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ProductListItem } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { getRecentlyViewedIds } from '@/lib/recentlyViewed';
import { Scroller, SectionHeader } from './HomeBits';

const MAX_CARDS = 12;

export default function RecentlyViewed() {
  const [items, setItems] = useState<ProductListItem[]>([]);

  useEffect(() => {
    const ids = getRecentlyViewedIds();
    const fromBrowser = ids.length
      ? api<ProductListItem[]>(`/api/products/by-ids?ids=${encodeURIComponent(ids.join(','))}`)
      : Promise.resolve<ProductListItem[]>([]);
    // Only ask the server when there is a session; otherwise it is a guaranteed 401.
    const fromServer = getStoredUser()
      ? api<ProductListItem[]>(`/api/me/recently-viewed?limit=${MAX_CARDS}`, { auth: true })
      : Promise.resolve<ProductListItem[]>([]);

    let live = true;
    Promise.all([fromBrowser.catch(() => []), fromServer.catch(() => [])]).then(
      ([browser, server]) => {
        if (!live) return;
        const seen = new Set<string>();
        const merged: ProductListItem[] = [];
        for (const product of [...browser, ...server]) {
          if (seen.has(product.id)) continue;
          seen.add(product.id);
          merged.push(product);
        }
        setItems(merged.slice(0, MAX_CARDS));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <section className="mt-10">
      <SectionHeader title="Recently Viewed" />
      <div className="mt-4">
        <Scroller>
          {items.map((product) => (
            <Link
              key={product.id}
              href={`/products/${product.slug}`}
              className="group/card w-36 shrink-0 rounded-2xl border border-gray-100 bg-white p-3 text-center transition hover:-translate-y-0.5 hover:shadow-lg sm:w-40"
            >
              <div className="overflow-hidden rounded-xl bg-cream-100">
                {product.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={product.imageUrl}
                    alt={product.title}
                    loading="lazy"
                    className="aspect-square w-full object-cover transition duration-300 group-hover/card:scale-105"
                  />
                ) : (
                  <div className="aspect-square w-full" />
                )}
              </div>
              <p className="mt-2 truncate text-xs font-semibold text-ink-900">{product.title}</p>
              <p className="mt-0.5 text-xs text-gray-500">
                <span className="font-bold text-ink-900">{formatPaise(product.pricePaise)}</span>
              </p>
            </Link>
          ))}
        </Scroller>
      </div>
    </section>
  );
}
