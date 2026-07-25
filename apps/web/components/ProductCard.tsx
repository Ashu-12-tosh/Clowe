'use client';

import Link from 'next/link';
import type { ProductListItem } from '@clowe/shared';
import { discountPercent, formatPaise } from '@/lib/format';
import WishlistButton from './WishlistButton';

interface Props {
  product: ProductListItem;
  inWishlist: boolean;
  onRemovedFromWishlist?: () => void;
}

export default function ProductCard({ product, inWishlist, onRemovedFromWishlist }: Props) {
  const off = discountPercent(product.pricePaise, product.mrpPaise);

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group relative overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:shadow-lg"
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-cream-100">
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.title}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-gray-400">No image</div>
        )}
        <WishlistButton
          productId={product.id}
          initialInWishlist={inWishlist}
          onRemoved={onRemovedFromWishlist}
        />
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-ink-900">{product.title}</p>
        <p className="mt-0.5 text-xs uppercase tracking-wide text-gray-400">
          {product.brand ?? product.categoryName}
        </p>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-bold text-brand-600">
              {formatPaise(product.pricePaise)}
            </span>
            {product.mrpPaise && off && (
              <span className="text-xs text-gray-400 line-through">
                {formatPaise(product.mrpPaise)}
              </span>
            )}
          </div>
          {product.ratingCount > 0 && product.ratingAvg != null && (
            <span className="text-xs text-gray-500">
              <span className="text-brand-400">★</span> {product.ratingAvg.toFixed(1)} (
              {product.ratingCount})
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
