'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ProductListItem } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { discountPercent, formatPaise } from '@/lib/format';
import { BADGES_EVENT } from '@/components/Header';
import WishlistButton from '@/components/WishlistButton';
import { BoltIcon } from '@/components/cart/CartIcons';

interface Props {
  product: ProductListItem;
  inWishlist: boolean;
  /** Promoted placement — renders a small "Sponsored" label. */
  sponsored?: boolean;
  onNavigate?: () => void;
}

/** Half-star aware rating row, e.g. ★★★★☆ 4.4 (2.1K). */
function Rating({ avg, count }: { avg: number; count: number }) {
  const compact = count >= 1000 ? `${(count / 1000).toFixed(1)}K` : String(count);
  return (
    <span className="t-rating flex items-center gap-1 text-gray-500">
      <span className="text-brand-400" aria-hidden>
        {[1, 2, 3, 4, 5].map((i) => (i <= Math.round(avg) ? '★' : '☆')).join('')}
      </span>
      <span className="font-semibold text-ink-900">{avg.toFixed(1)}</span>
      <span>({compact})</span>
    </span>
  );
}

/**
 * Listing card for the category pages: discount badge, wishlist heart,
 * rating, price block and a working Add to Cart / Buy Now pair.
 */
export default function CategoryProductCard({
  product,
  inWishlist,
  sponsored = false,
  onNavigate,
}: Props) {
  const router = useRouter();
  const off = discountPercent(product.pricePaise, product.mrpPaise);
  const [state, setState] = useState<'idle' | 'busy' | 'added'>('idle');
  const [error, setError] = useState('');

  async function add(mode: 'cart' | 'buy') {
    if (!getStoredUser()) {
      router.push('/login');
      return;
    }
    // No sellable variant — send them to the product page to see why.
    if (!product.defaultVariantId) {
      router.push(`/products/${product.slug}`);
      return;
    }
    setError('');
    setState('busy');
    try {
      await api('/api/cart/items', {
        body: { variantId: product.defaultVariantId, quantity: 1 },
        auth: true,
      });
      window.dispatchEvent(new Event(BADGES_EVENT));
      if (mode === 'buy') {
        router.push('/checkout');
        return;
      }
      setState('added');
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add to cart');
      setState('idle');
    }
  }

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:shadow-lg">
      <Link
        href={`/products/${product.slug}`}
        onClick={onNavigate}
        className="relative block aspect-square overflow-hidden bg-cream-100"
      >
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.title}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-sm text-gray-400">
            No image
          </span>
        )}
        {off !== null && (
          <span className="t-badge absolute left-2 top-2 rounded bg-brand-600 px-1.5 py-0.5 text-white">
            {off}% OFF
          </span>
        )}
        {product.brand && (
          <span className="absolute left-2 top-8 rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-semibold text-ink-900 backdrop-blur">
            {product.brand}
          </span>
        )}
        {!product.inStock && (
          <span className="absolute inset-x-0 bottom-0 bg-ink-900/80 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-white">
            Out of stock
          </span>
        )}
      </Link>

      <WishlistButton productId={product.id} initialInWishlist={inWishlist} />

      <div className="flex flex-1 flex-col p-3">
        {sponsored && <p className="mb-0.5 text-[10px] font-medium text-gray-400">Sponsored</p>}
        <Link
          href={`/products/${product.slug}`}
          onClick={onNavigate}
          className="t-card-title line-clamp-2 text-ink-900 hover:text-brand-600"
        >
          {product.title}
        </Link>

        <div className="mt-1.5 min-h-4">
          {product.ratingCount > 0 && product.ratingAvg != null && (
            <Rating avg={product.ratingAvg} count={product.ratingCount} />
          )}
        </div>

        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="t-price text-ink-900">{formatPaise(product.pricePaise)}</span>
          {product.mrpPaise && off !== null && (
            <span className="t-price-old text-gray-400 line-through">
              {formatPaise(product.mrpPaise)}
            </span>
          )}
        </div>

        {error && <p className="mt-1 text-[11px] font-medium text-red-600">{error}</p>}

        <div className="mt-auto flex gap-1.5 pt-3">
          <button
            onClick={() => void add('cart')}
            disabled={state === 'busy' || !product.inStock}
            className={`flex-1 rounded-lg py-2 text-xs font-bold transition disabled:opacity-50 ${
              state === 'added'
                ? 'bg-green-600 text-white'
                : 'bg-ink-900 text-white hover:bg-ink-800'
            }`}
          >
            {!product.inStock
              ? 'Out of Stock'
              : state === 'busy'
                ? 'Adding…'
                : state === 'added'
                  ? '✓ Added'
                  : 'Add to Cart'}
          </button>
          <button
            onClick={() => void add('buy')}
            disabled={state === 'busy' || !product.inStock}
            title="Buy now"
            aria-label={`Buy ${product.title} now`}
            className="flex w-9 shrink-0 items-center justify-center rounded-lg border border-brand-600 text-brand-600 transition hover:bg-brand-50 disabled:opacity-40"
          >
            <BoltIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
