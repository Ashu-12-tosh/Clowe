'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ProductListItem, WishlistEntry, WishlistShare } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { getPublicSettings } from '@/lib/settings';
import { BADGES_EVENT } from '@/components/Header';
import { Scroller } from '@/components/home/HomeBits';
import ProductCard from '@/components/ProductCard';
import WishlistCard from '@/components/wishlist/WishlistCard';
import {
  BoxIcon,
  HeadsetIcon,
  HeartIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

const SORTS = {
  recent: 'Recently Added',
  price_asc: 'Price: Low to High',
  price_desc: 'Price: High to Low',
  discount: 'Biggest Discount',
} as const;
type SortKey = keyof typeof SORTS;

const INFO_STRIP = [
  {
    Icon: HeartIcon,
    title: 'Never miss a price drop',
    text: 'We flag saved items the moment they get cheaper.',
  },
  {
    Icon: BoxIcon,
    title: 'Items in your wishlist',
    text: "Don't go out of stock! Add to cart now.",
  },
  {
    Icon: TruckIcon,
    title: 'Move all to bag',
    text: 'Save time and checkout everything together.',
  },
];

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns on eligible items' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

function discountOf(entry: WishlistEntry): number {
  const { pricePaise, mrpPaise } = entry.product;
  if (!mrpPaise || mrpPaise <= pricePaise) return 0;
  return (mrpPaise - pricePaise) / mrpPaise;
}

export default function WishlistPage() {
  const [items, setItems] = useState<WishlistEntry[] | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [dropsOnly, setDropsOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [movingAll, setMovingAll] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [tryOnMinPaise, setTryOnMinPaise] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<ProductListItem[]>([]);
  const [recentlyViewed, setRecentlyViewed] = useState<ProductListItem[]>([]);

  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    api<WishlistEntry[]>('/api/wishlist', { auth: true })
      .then(setItems)
      .catch(() => setItems([]));
    getPublicSettings()
      .then((s) => setTryOnMinPaise(s.tryonMinPricePaise))
      .catch(() => {});
    api<ProductListItem[]>('/api/me/recently-viewed?limit=10', { auth: true })
      .then(setRecentlyViewed)
      .catch(() => {});
  }, []);

  // Suggestions follow whatever the wishlist is mostly made of.
  const topCategory = items?.[0]?.rootCategorySlug;
  useEffect(() => {
    const query = topCategory ? `category=${encodeURIComponent(topCategory)}&limit=12` : 'limit=12';
    api<{ items: ProductListItem[] }>(`/api/products?${query}&sort=popularity`)
      .then((data) => setSuggestions(data.items))
      .catch(() => {});
  }, [topCategory]);

  function setBusy(productId: string, busy: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(productId);
      else next.delete(productId);
      return next;
    });
  }

  async function remove(productId: string) {
    setError('');
    setBusy(productId, true);
    try {
      await api(`/api/wishlist/${productId}`, { method: 'DELETE', auth: true });
      setItems((prev) => (prev ?? []).filter((e) => e.productId !== productId));
      window.dispatchEvent(new Event(BADGES_EVENT));
    } catch {
      setError('Could not remove that item');
    } finally {
      setBusy(productId, false);
    }
  }

  async function moveToCart(productIds: string[], all = false) {
    setError('');
    setNotice('');
    if (all) setMovingAll(true);
    else productIds.forEach((id) => setBusy(id, true));
    try {
      const result = await api<{ moved: number; skipped: string[]; items: WishlistEntry[] }>(
        '/api/wishlist/move-to-cart',
        { body: all ? {} : { productIds }, auth: true },
      );
      setItems(result.items);
      window.dispatchEvent(new Event(BADGES_EVENT));
      setNotice(
        result.skipped.length > 0
          ? `${result.moved} moved to cart · ${result.skipped.length} out of stock and kept here`
          : `${result.moved} item${result.moved === 1 ? '' : 's'} moved to your cart`,
      );
      setTimeout(() => setNotice(''), 4000);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not move to cart');
    } finally {
      if (all) setMovingAll(false);
      else productIds.forEach((id) => setBusy(id, false));
    }
  }

  async function share() {
    setError('');
    try {
      const { path } = await api<WishlistShare>('/api/wishlist/share', {
        method: 'POST',
        auth: true,
      });
      if (!path) return;
      const url = `${window.location.origin}${path}`;
      if (navigator.share) {
        await navigator.share({ title: 'My Clowe wishlist', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setNotice('Share link copied to clipboard');
      setTimeout(() => setNotice(''), 4000);
    } catch (err) {
      if (err instanceof ApiRequestError) setError(err.message);
    }
  }

  // Category chips, built from what is actually saved.
  const chips = useMemo(() => {
    const counts = new Map<string, { slug: string; name: string; count: number }>();
    for (const entry of items ?? []) {
      const row = counts.get(entry.rootCategorySlug) ?? {
        slug: entry.rootCategorySlug,
        name: entry.rootCategoryName,
        count: 0,
      };
      row.count += 1;
      counts.set(entry.rootCategorySlug, row);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [items]);

  const visible = useMemo(() => {
    let list = [...(items ?? [])];
    if (category !== 'all') list = list.filter((e) => e.rootCategorySlug === category);
    if (inStockOnly) list = list.filter((e) => e.product.inStock);
    if (dropsOnly) {
      list = list.filter(
        (e) => e.priceAtAddPaise !== null && e.product.pricePaise < e.priceAtAddPaise,
      );
    }
    switch (sort) {
      case 'price_asc':
        return list.sort((a, b) => a.product.pricePaise - b.product.pricePaise);
      case 'price_desc':
        return list.sort((a, b) => b.product.pricePaise - a.product.pricePaise);
      case 'discount':
        return list.sort((a, b) => discountOf(b) - discountOf(a));
      default:
        return list.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    }
  }, [items, category, sort, inStockOnly, dropsOnly]);

  const inStockCount = (items ?? []).filter((e) => e.product.inStock).length;
  const wishlistIds = new Set((items ?? []).map((e) => e.productId));

  // --- Logged out / empty ---------------------------------------------------

  if (loggedOut) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <span className="text-5xl">♡</span>
        <h1 className="mt-4 font-display text-2xl font-bold text-ink-900">Your wishlist awaits</h1>
        <p className="mt-2 text-sm text-gray-500">Login to see the items you saved.</p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          Login
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-10 pt-4">
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Wishlist</span>
      </nav>

      {/* Title row */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-page-title flex items-center gap-2 text-ink-900">
            My Wishlist <HeartIcon className="h-6 w-6 text-red-500" filled />
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {items === null
              ? 'Loading…'
              : `${items.length} item${items.length === 1 ? '' : 's'} saved in your wishlist`}
          </p>
        </div>
        {items && items.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void share()}
              className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-ink-900 transition hover:border-brand-600 hover:text-brand-600"
            >
              ↗ Share Wishlist
            </button>
            <button
              onClick={() => void moveToCart([], true)}
              disabled={movingAll || inStockCount === 0}
              className="rounded-lg bg-ink-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-ink-800 disabled:opacity-50"
            >
              {movingAll ? 'Moving…' : `Move All to Bag${inStockCount ? ` (${inStockCount})` : ''}`}
            </button>
          </div>
        )}
      </div>

      {notice && (
        <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {items && items.length > 0 && (
        <>
          {/* Chips + sort */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setCategory('all')}
                className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  category === 'all'
                    ? 'bg-ink-900 text-white'
                    : 'border border-gray-300 text-gray-600 hover:border-ink-900'
                }`}
              >
                All ({items.length})
              </button>
              {chips.map((chip) => (
                <button
                  key={chip.slug}
                  onClick={() => setCategory(chip.slug)}
                  className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                    category === chip.slug
                      ? 'bg-ink-900 text-white'
                      : 'border border-gray-300 text-gray-600 hover:border-ink-900'
                  }`}
                >
                  {chip.name} ({chip.count})
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-gray-500">Sort by:</span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-brand-600"
                >
                  {Object.entries(SORTS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => setShowFilters((v) => !v)}
                className={`rounded-lg border px-4 py-2 text-sm font-semibold transition ${
                  inStockOnly || dropsOnly
                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                    : 'border-gray-300 text-ink-900 hover:border-ink-900'
                }`}
              >
                ⚙ Filter
              </button>
            </div>
          </div>

          {showFilters && (
            <div className="mt-3 flex flex-wrap gap-4 rounded-2xl border border-gray-100 bg-white px-4 py-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={inStockOnly}
                  onChange={(e) => setInStockOnly(e.target.checked)}
                  className="h-4 w-4 accent-brand-600"
                />
                In stock only
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={dropsOnly}
                  onChange={(e) => setDropsOnly(e.target.checked)}
                  className="h-4 w-4 accent-brand-600"
                />
                Price drops only
              </label>
              {(inStockOnly || dropsOnly) && (
                <button
                  onClick={() => {
                    setInStockOnly(false);
                    setDropsOnly(false);
                  }}
                  className="text-sm font-semibold text-brand-600 hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* Grid */}
      {items === null ? (
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-80 animate-pulse rounded-2xl bg-cream-100" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-gray-100 bg-white py-16 text-center">
          <span className="text-5xl">♡</span>
          <h2 className="mt-4 font-display text-xl font-bold text-ink-900">
            Your wishlist is empty
          </h2>
          <p className="mt-2 text-sm text-gray-500">
            Tap the heart on any product to save it for later.
          </p>
          <Link
            href="/products"
            className="mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
          >
            Start Shopping
          </Link>
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-gray-100 bg-white py-12 text-center">
          <p className="text-sm text-gray-500">Nothing matches these filters.</p>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {visible.map((entry) => (
            <WishlistCard
              key={entry.productId}
              entry={entry}
              tryOnMinPaise={tryOnMinPaise}
              busy={busyIds.has(entry.productId) || movingAll}
              onMoveToCart={() => void moveToCart([entry.productId])}
              onRemove={() => void remove(entry.productId)}
            />
          ))}
        </div>
      )}

      {/* Info strip */}
      {items && items.length > 0 && (
        <section className="mt-6 grid gap-4 rounded-2xl bg-cream-50 p-5 sm:grid-cols-3">
          {INFO_STRIP.map(({ Icon, title, text }) => (
            <div key={title} className="flex items-start gap-2.5">
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink-900">{title}</p>
                <p className="text-xs text-gray-500">{text}</p>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Rails */}
      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        {suggestions.filter((p) => !wishlistIds.has(p.id)).length > 0 && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-bold text-ink-900">You may also like</h2>
              <Link href="/products" className="text-xs font-semibold text-brand-600 hover:underline">
                View All →
              </Link>
            </div>
            <div className="mt-3">
              <Scroller>
                {suggestions
                  .filter((p) => !wishlistIds.has(p.id))
                  .slice(0, 10)
                  .map((product) => (
                    <div key={product.id} className="w-36 shrink-0 sm:w-40">
                      <ProductCard product={product} inWishlist={false} />
                    </div>
                  ))}
              </Scroller>
            </div>
          </section>
        )}

        {recentlyViewed.length > 0 && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-bold text-ink-900">Recently Viewed</h2>
              <Link
                href="/account/recently-viewed"
                className="text-xs font-semibold text-brand-600 hover:underline"
              >
                View All →
              </Link>
            </div>
            <div className="mt-3">
              <Scroller>
                {recentlyViewed.map((product) => (
                  <div key={product.id} className="w-36 shrink-0 sm:w-40">
                    <ProductCard product={product} inWishlist={wishlistIds.has(product.id)} />
                  </div>
                ))}
              </Scroller>
            </div>
          </section>
        )}
      </div>

      {/* Trust strip */}
      <section className="mt-6 grid gap-3 rounded-2xl border border-gray-100 bg-white p-5 sm:grid-cols-2 lg:grid-cols-5">
        {TRUST_STRIP.map(({ Icon, title, text }) => (
          <div key={title} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-ink-900">{title}</p>
              <p className="text-[11px] text-gray-500">{text}</p>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
