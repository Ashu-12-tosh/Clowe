'use client';

// Shared building blocks for the landing page: horizontal scroller with
// arrows, product cards with quick add-to-cart, and the deal countdown.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { HomeProductCard } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BADGES_EVENT } from '@/components/Header';
import { responsiveImage } from '@clowe/shared';

// ---------------------------------------------------------------------------

export function SectionHeader({
  title,
  accent,
  right,
  href,
}: {
  title: string;
  accent?: React.ReactNode;
  right?: React.ReactNode;
  href?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-3">
        <h2 className="t-section text-ink-900">{title}</h2>
        {accent}
      </div>
      <div className="flex items-center gap-3">
        {right}
        {href && (
          // eslint-disable-next-line no-restricted-syntax -- route from a table defined in code, not data
          <Link href={href} className="text-sm font-semibold text-brand-600 hover:underline">
            View All →
          </Link>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Horizontal scroll rail with hover arrows (desktop) and free scroll (touch). */
export function Scroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const scrollBy = (dir: 1 | -1) =>
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <div className="group relative">
      <div ref={ref} className="scrollbar-none -mx-1 flex gap-4 overflow-x-auto scroll-smooth px-1 py-1">
        {children}
      </div>
      <button
        onClick={() => scrollBy(-1)}
        aria-label="Scroll left"
        className="absolute -left-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-gray-200 bg-white text-ink-900 shadow-md transition hover:border-brand-600 lg:group-hover:flex"
      >
        ‹
      </button>
      <button
        onClick={() => scrollBy(1)}
        aria-label="Scroll right"
        className="absolute -right-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-gray-200 bg-white text-ink-900 shadow-md transition hover:border-brand-600 lg:group-hover:flex"
      >
        ›
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

const BADGE_STYLES: Record<NonNullable<HomeProductCard['badge']>, [string, string]> = {
  BEST_SELLER: ['Best Seller', 'bg-brand-600 text-white'],
  NEW: ['New', 'bg-ink-900 text-white'],
  TRENDING: ['Trending', 'bg-brand-100 text-brand-700'],
};

/** Quick add-to-cart icon button (uses the card's default in-stock variant). */
function QuickAdd({ variantId }: { variantId: string | null }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  if (!variantId) return null;

  async function add(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!getStoredUser()) {
      router.push('/login');
      return;
    }
    setState('busy');
    try {
      await api('/api/cart/items', { body: { variantId, quantity: 1 }, auth: true });
      window.dispatchEvent(new Event(BADGES_EVENT));
      setState('done');
      setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('idle');
    }
  }

  return (
    <button
      onClick={(e) => void add(e)}
      disabled={state !== 'idle'}
      aria-label="Add to cart"
      title="Add to cart"
      className={`flex h-8 w-8 items-center justify-center rounded-full border text-sm shadow-sm transition ${
        state === 'done'
          ? 'border-green-600 bg-green-600 text-white'
          : 'border-gray-200 bg-white text-ink-900 hover:border-brand-600 hover:text-brand-600'
      }`}
    >
      {state === 'done' ? '✓' : state === 'busy' ? '…' : '🛒'}
    </button>
  );
}

/** Product card for the Deals rail. */
export function DealCard({ product }: { product: HomeProductCard }) {
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group/card w-44 shrink-0 rounded-2xl border border-gray-100 bg-white p-3 transition hover:-translate-y-0.5 hover:shadow-lg sm:w-52"
    >
      <div className="relative overflow-hidden rounded-xl bg-cream-100">
        {product.discountPercent != null && (
          <span className="absolute left-2 top-2 z-10 rounded-md bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
            {product.discountPercent}% OFF
          </span>
        )}
        {product.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            {...responsiveImage(product.imageUrl, '(max-width: 640px) 45vw, 220px')}
            alt={product.title}
            loading="lazy"
            className="aspect-square w-full object-cover transition duration-300 group-hover/card:scale-105"
          />
        )}
      </div>
      <p className="mt-2.5 truncate text-sm font-semibold text-ink-900">{product.title}</p>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-sm font-bold text-ink-900">{formatPaise(product.pricePaise)}</span>
        {product.mrpPaise != null && product.discountPercent != null && (
          <span className="text-xs text-gray-400 line-through">{formatPaise(product.mrpPaise)}</span>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        {product.ratingAvg != null ? (
          <span className="text-xs text-gray-500">
            <span className="text-brand-400">★</span> {product.ratingAvg.toFixed(1)} (
            {product.ratingCount > 999
              ? `${(product.ratingCount / 1000).toFixed(1)}K`
              : product.ratingCount}
            )
          </span>
        ) : (
          <span />
        )}
        <QuickAdd variantId={product.defaultVariantId} />
      </div>
    </Link>
  );
}

/** Compact card for the Trending rail, or (`fluid`) a cell of the Trending grid. */
export function TrendingCard({ product, fluid = false }: { product: HomeProductCard; fluid?: boolean }) {
  const [label, style] = product.badge ? BADGE_STYLES[product.badge] : ['', ''];
  return (
    <Link
      href={`/products/${product.slug}`}
      className={`group/card rounded-2xl border border-gray-100 bg-white p-3 text-center transition hover:-translate-y-0.5 hover:shadow-lg ${fluid ? 'w-full' : 'w-36 shrink-0 sm:w-40'}`}
    >
      <div className="relative overflow-hidden rounded-xl bg-cream-100">
        {product.badge && (
          <span className={`absolute left-1.5 top-1.5 z-10 rounded-md px-1.5 py-0.5 text-[9px] font-bold ${style}`}>
            {label}
          </span>
        )}
        {product.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            {...responsiveImage(product.imageUrl, '(max-width: 640px) 45vw, 220px')}
            alt={product.title}
            loading="lazy"
            className="aspect-square w-full object-cover transition duration-300 group-hover/card:scale-105"
          />
        )}
      </div>
      <p className="mt-2 truncate text-xs font-semibold text-ink-900">{product.title}</p>
      <p className="mt-0.5 text-xs text-gray-500">
        From <span className="font-bold text-ink-900">{formatPaise(product.pricePaise)}</span>
      </p>
    </Link>
  );
}

/**
 * The hero while no banner is up: what is on sale now, in its sellers' own
 * photos — never stock art. Nothing to show: no hero at all.
 */
export function ProductHero({ products }: { products: HomeProductCard[] }) {
  const shown = products.filter((p) => p.imageUrl).slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <section
      className="grid items-center gap-6 overflow-hidden rounded-3xl bg-cream-100 p-5 sm:p-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:py-10 lg:pl-14"
      data-product-hero
    >
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-brand-600">Now on Clowe</p>
        <h1 className="mt-2 font-display text-3xl font-bold leading-tight text-ink-900 sm:text-4xl xl:text-5xl">
          Everything you need, <span className="text-brand-600">one marketplace.</span>
        </h1>
        <p className="mt-3 max-w-lg text-sm text-gray-600 sm:text-base">
          Clothing, footwear, phones and more from sellers across India. Every product and price is here to browse.
        </p>
        <Link
          href="/products"
          className="mt-6 inline-block rounded-lg bg-ink-900 px-6 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          Shop all products
        </Link>
      </div>
      <div className="grid grid-cols-4 gap-2 sm:gap-3 lg:w-[24rem] lg:grid-cols-2">
        {shown.map((product, i) => (
          <Link
            key={product.id}
            href={`/products/${product.slug}`}
            className="overflow-hidden rounded-2xl bg-white"
            title={product.title}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              {...responsiveImage(product.imageUrl!, '(max-width: 1024px) 25vw, 192px')}
              alt={product.title}
              loading={i < 2 ? 'eager' : 'lazy'}
              className="aspect-square w-full object-cover"
            />
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function pad(n: number) {
  return String(Math.max(0, n)).padStart(2, '0');
}

/** Live HH:MM:SS countdown. Calls onExpire once when it hits zero. */
export function Countdown({ endsAt, onExpire }: { endsAt: string; onExpire?: () => void }) {
  const [left, setLeft] = useState(() => new Date(endsAt).getTime() - Date.now());
  const expiredRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      const remaining = new Date(endsAt).getTime() - Date.now();
      setLeft(remaining);
      if (remaining <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpire?.();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [endsAt, onExpire]);

  const total = Math.max(0, Math.floor(left / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return (
    <span className="flex items-center gap-1 text-sm font-bold text-ink-900" aria-label="Deal ends in">
      <span className="text-xs font-medium text-gray-500">Ends in</span>
      {[hours, minutes, seconds].map((value, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-gray-400">:</span>}
          <span className="rounded-md bg-ink-900 px-1.5 py-0.5 font-mono text-xs text-white">
            {pad(value)}
          </span>
        </span>
      ))}
    </span>
  );
}
