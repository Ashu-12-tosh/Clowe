'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { safeHref, type AdServeBanner, type AdServeItem, type AdServeResponse, type AdSurface } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import ProductCard from './ProductCard';
import AdBadge from './AdBadge';

// ---------------------------------------------------------------------------
// Paid placements on the storefront (owner's Batch 2). Every one sits in its
// own slot with a visible "Sponsored" or "Ad" label; organic results are
// never re-ordered by money.
// ---------------------------------------------------------------------------

const EMPTY: AdServeResponse = { top: [], items: [], banners: [] };

/** A random id kept in this browser, so one device's clicks count once. */
function deviceId(): string {
  try {
    let id = localStorage.getItem('clowe_device');
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
      localStorage.setItem('clowe_device', id);
    }
    return id;
  } catch {
    return `nostore-${Date.now()}`;
  }
}

/** Fire-and-forget click beacon. */
export function trackAd(ad: { campaignId: string; slotType: string; productId?: string }) {
  if (!ad.campaignId) return; // Premium featured cards are not campaigns
  api('/api/ad-serve/click', {
    method: 'POST',
    body: { campaignId: ad.campaignId, slotType: ad.slotType, deviceId: deviceId(), ...(ad.productId ? { productId: ad.productId } : {}) },
  }).catch(() => {});
}

/** The ads for a surface; pass null to fetch nothing. Impressions are counted once per load. */
export function useAds(surface: AdSurface | null, ctx: { q?: string; category?: string; productId?: string } = {}): AdServeResponse {
  const [ads, setAds] = useState<AdServeResponse>(EMPTY);
  const key = surface ? `${surface}|${ctx.q ?? ''}|${ctx.category ?? ''}|${ctx.productId ?? ''}` : '';
  const counted = useRef('');
  useEffect(() => {
    if (!surface) {
      setAds(EMPTY);
      return;
    }
    const qs = new URLSearchParams({ surface });
    if (ctx.q) qs.set('q', ctx.q);
    if (ctx.category) qs.set('category', ctx.category);
    if (ctx.productId) qs.set('productId', ctx.productId);
    let live = true;
    api<AdServeResponse>(`/api/ad-serve?${qs.toString()}`)
      .then((r) => {
        if (!live) return;
        setAds(r);
        const shown = [...r.top, ...r.items, ...r.banners].filter((a) => a.campaignId).map((a) => ({ campaignId: a.campaignId, slotType: a.slotType }));
        if (shown.length && counted.current !== key) {
          counted.current = key;
          api('/api/ad-serve/impressions', { method: 'POST', body: { items: shown } }).catch(() => {});
        }
      })
      .catch(() => live && setAds(EMPTY));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return ads;
}

/** Booked banners (homepage or category), each labelled. */
export function AdBanners({ banners }: { banners: AdServeBanner[] }) {
  if (banners.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {banners.map((b) => (
        <Link
          key={b.campaignId}
          href={safeHref(b.href) ?? "/"}
          onClick={() => trackAd(b)}
          className="group relative block overflow-hidden rounded-2xl border border-gray-100 bg-cream-100"
        >
          {b.creativeUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.creativeUrl} alt={b.headline ?? 'Advertisement'} className="aspect-[3/1] w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex aspect-[3/1] items-center justify-center p-4 text-lg font-semibold text-ink-900">{b.headline}</div>
          )}
          <AdBadge label={b.label} className="absolute left-2 top-2" />
          {b.creativeUrl && b.headline && (
            <p className="truncate px-3 py-2 text-sm font-medium text-ink-900">{b.headline}</p>
          )}
        </Link>
      ))}
    </div>
  );
}

/** Product ids the paid row already shows, so the organic grid can skip duplicates. */
export function adProductIds(items: AdServeItem[]): Set<string> {
  return new Set(items.map((i) => i.product.id));
}

/** The homepage's paid section: booked banners and featured cards, labelled; nothing when none are booked. */
export function HomeAds() {
  const ads = useAds('HOME');
  const [wishlist, setWishlist] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (ads.items.length) fetchWishlistIds().then(setWishlist);
  }, [ads.items.length]);
  if (ads.banners.length === 0 && ads.items.length === 0) return null;
  return (
    <section className="mt-10" aria-label="Sponsored">
      <AdBanners banners={ads.banners} />
      {ads.items.length > 0 && (
        <div className={`grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 ${ads.banners.length ? 'mt-4' : ''}`}>
          {ads.items.map((ad) => (
            <ProductCard
              key={`${ad.campaignId}-${ad.product.id}`}
              product={ad.product}
              inWishlist={wishlist.has(ad.product.id)}
              sponsored={ad.label}
              onNavigate={() => trackAd({ ...ad, productId: ad.product.id })}
            />
          ))}
        </div>
      )}
    </section>
  );
}
