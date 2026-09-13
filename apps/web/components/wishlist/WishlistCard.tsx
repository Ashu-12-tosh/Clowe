'use client';

import Link from 'next/link';
import type { WishlistEntry } from '@clowe/shared';
import { discountPercent, formatPaise } from '@/lib/format';
import { HeartIcon, CartIcon, TrashIcon } from '@/components/cart/CartIcons';

interface Props {
  entry: WishlistEntry;
  /** Min price (paise) at which this category offers AI Try-On; null = never. */
  tryOnMinPaise: number | null;
  busy: boolean;
  onMoveToCart: () => void;
  onRemove: () => void;
}

/** Badge shown top-left: a real price drop wins over the catalogue badges. */
function badgeFor(entry: WishlistEntry): { text: string; className: string } | null {
  const { product, priceAtAddPaise } = entry;
  if (priceAtAddPaise !== null && product.pricePaise < priceAtAddPaise) {
    return { text: 'Price drop', className: 'bg-green-600 text-white' };
  }
  if (entry.isBestSeller) return { text: 'Best Seller', className: 'bg-cream-200 text-ink-900' };
  if (entry.isNew) return { text: 'New', className: 'bg-ink-900 text-white' };
  const off = discountPercent(product.pricePaise, product.mrpPaise);
  if (off !== null) return { text: `−${off}%`, className: 'bg-brand-600 text-white' };
  return null;
}

export default function WishlistCard({
  entry,
  tryOnMinPaise,
  busy,
  onMoveToCart,
  onRemove,
}: Props) {
  const { product } = entry;
  const off = discountPercent(product.pricePaise, product.mrpPaise);
  const badge = badgeFor(entry);
  const tryOn =
    entry.tryOnEligible &&
    tryOnMinPaise !== null &&
    product.pricePaise >= tryOnMinPaise;
  const droppedBy =
    entry.priceAtAddPaise !== null && product.pricePaise < entry.priceAtAddPaise
      ? entry.priceAtAddPaise - product.pricePaise
      : 0;

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:shadow-md ${
        busy ? 'opacity-60' : ''
      }`}
    >
      <div className="relative">
        <Link href={`/products/${product.slug}`} className="block aspect-square overflow-hidden bg-cream-100">
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.imageUrl}
              alt={product.title}
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 hover:scale-105"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-sm text-gray-400">
              No image
            </span>
          )}
        </Link>

        {badge && (
          <span
            className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${badge.className}`}
          >
            {badge.text}
          </span>
        )}

        <button
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove ${product.title} from wishlist`}
          title="Remove from wishlist"
          className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-red-500 shadow transition hover:bg-white disabled:opacity-50"
        >
          <HeartIcon filled />
        </button>

        {tryOn && (
          <Link
            href={`/products/${product.slug}?tryon=1`}
            className="absolute bottom-2 right-2 rounded border border-brand-200 bg-white/95 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700 backdrop-blur transition hover:bg-brand-50"
          >
            ✨ AI Try-On
          </Link>
        )}

        {!product.inStock && (
          <span className="absolute inset-x-0 bottom-0 bg-ink-900/80 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-white">
            Out of stock
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        {product.brand && <p className="t-card-brand text-gray-500">{product.brand}</p>}
        <Link
          href={`/products/${product.slug}`}
          className="t-card-title line-clamp-2 text-ink-900 hover:text-brand-600"
        >
          {product.title}
        </Link>

        {product.ratingCount > 0 && product.ratingAvg != null && (
          <p className="mt-1 text-[11px] text-gray-500">
            <span className="text-brand-400">★</span>{' '}
            <span className="font-semibold text-ink-900">{product.ratingAvg.toFixed(1)}</span> (
            {product.ratingCount >= 1000
              ? `${(product.ratingCount / 1000).toFixed(1)}K`
              : product.ratingCount}
            )
          </p>
        )}

        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="t-price text-ink-900">{formatPaise(product.pricePaise)}</span>
          {product.mrpPaise && off !== null && (
            <>
              <span className="t-price-old text-gray-400 line-through">
                {formatPaise(product.mrpPaise)}
              </span>
              <span className="t-discount text-brand-600">{off}% OFF</span>
            </>
          )}
        </div>

        {droppedBy > 0 && (
          <p className="mt-1 text-[11px] font-semibold text-green-700">
            ↓ {formatPaise(droppedBy)} since you saved it
          </p>
        )}

        {(product.sizes.length > 0 || product.colors.length > 0) && (
          <p className="mt-1 truncate text-[11px] text-gray-500">
            {product.sizes.length > 0 && <>Size: {product.sizes.slice(0, 2).join(', ')}</>}
            {product.sizes.length > 0 && product.colors.length > 0 && (
              <span className="mx-1.5 text-gray-300">|</span>
            )}
            {product.colors.length > 0 && <>Color: {product.colors.slice(0, 2).join(', ')}</>}
          </p>
        )}

        <div className="mt-auto flex gap-1.5 pt-3">
          <button
            onClick={onMoveToCart}
            disabled={busy || !product.inStock}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-gray-300 py-2 text-xs font-bold text-ink-900 transition hover:border-brand-600 hover:text-brand-600 disabled:opacity-40"
          >
            <CartIcon className="h-3.5 w-3.5" />
            {product.inStock ? 'Move to Cart' : 'Out of Stock'}
          </button>
          <button
            onClick={onRemove}
            disabled={busy}
            aria-label={`Delete ${product.title}`}
            title="Remove"
            className="flex w-9 shrink-0 items-center justify-center rounded-lg border border-gray-300 text-gray-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-40"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
