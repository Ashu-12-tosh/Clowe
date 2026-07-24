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
      className="group relative overflow-hidden rounded-xl border border-gray-200 bg-white transition hover:shadow-md"
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-gray-100">
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
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {product.brand ?? product.categoryName}
        </p>
        <p className="mt-0.5 truncate text-sm font-medium text-gray-900">{product.title}</p>
        <div className="mt-1.5 flex items-baseline gap-2 text-sm">
          <span className="font-bold">{formatPaise(product.pricePaise)}</span>
          {product.mrpPaise && off && (
            <>
              <span className="text-xs text-gray-400 line-through">
                {formatPaise(product.mrpPaise)}
              </span>
              <span className="text-xs font-semibold text-green-600">{off}% off</span>
            </>
          )}
        </div>
        {product.ratingCount > 0 && product.ratingAvg != null && (
          <p className="mt-1 text-xs text-gray-500">
            ★ {product.ratingAvg.toFixed(1)} ({product.ratingCount})
          </p>
        )}
      </div>
    </Link>
  );
}
