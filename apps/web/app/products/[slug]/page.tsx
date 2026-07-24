'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { ProductDetail } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import { discountPercent, formatPaise } from '@/lib/format';
import WishlistButton from '@/components/WishlistButton';
import AddToCartButton from '@/components/AddToCartButton';
import TryOnModal from '@/components/TryOnModal';
import ReviewsSection from '@/components/ReviewsSection';
import RelatedProducts from '@/components/RelatedProducts';

/** Image with hover-to-zoom (desktop): magnifies around the cursor. */
function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState('center');
  const [zoomed, setZoomed] = useState(false);

  return (
    <div
      ref={ref}
      className="relative aspect-[3/4] cursor-zoom-in overflow-hidden rounded-xl bg-gray-100"
      onMouseMove={(e) => {
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        setOrigin(`${x}% ${y}%`);
      }}
      onMouseEnter={() => setZoomed(true)}
      onMouseLeave={() => setZoomed(false)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="h-full w-full object-cover transition-transform duration-150"
        style={{ transformOrigin: origin, transform: zoomed ? 'scale(2)' : 'scale(1)' }}
      />
    </div>
  );
}

export default function ProductDetailPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [inWishlist, setInWishlist] = useState(false);
  const [imageIndex, setImageIndex] = useState(0);
  const [color, setColor] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [tryOnOpen, setTryOnOpen] = useState(false);

  useEffect(() => {
    api<ProductDetail>(`/api/products/${slug}`)
      .then((p) => {
        setProduct(p);
        setColor(p.variants[0]?.color ?? null);
        fetchWishlistIds().then((ids) => setInWishlist(ids.has(p.id)));
      })
      .catch(() => setNotFound(true));
  }, [slug]);

  const colorOptions = useMemo(
    () => [...new Set(product?.variants.map((v) => v.color) ?? [])],
    [product],
  );
  const sizeOptions = useMemo(
    () => product?.variants.filter((v) => v.color === color) ?? [],
    [product, color],
  );
  const selected = sizeOptions.find((v) => v.size === size) ?? sizeOptions[0] ?? null;
  const off = selected ? discountPercent(selected.pricePaise, selected.mrpPaise) : null;

  if (notFound) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-20 text-center">
        <p className="text-lg font-semibold">Product not found</p>
        <Link href="/products" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
          ← Back to shop
        </Link>
      </main>
    );
  }

  if (!product) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid gap-8 md:grid-cols-2">
          <div className="aspect-[3/4] animate-pulse rounded-xl bg-gray-200" />
          <div className="space-y-4">
            <div className="h-6 w-2/3 animate-pulse rounded bg-gray-200" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-gray-200" />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <nav className="text-xs text-gray-500">
        <Link href="/products" className="hover:text-brand-600">
          Shop
        </Link>{' '}
        /{' '}
        <Link href={`/products?category=${product.category.slug}`} className="hover:text-brand-600">
          {product.category.name}
        </Link>{' '}
        / <span className="text-gray-700">{product.title}</span>
      </nav>

      <div className="mt-4 grid gap-8 md:grid-cols-2">
        {/* ---------------- Gallery ---------------- */}
        <div>
          {product.images[imageIndex] && (
            <ZoomImage src={product.images[imageIndex].url} alt={product.title} />
          )}
          {product.images.length > 1 && (
            <div className="mt-3 flex gap-2">
              {product.images.map((img, i) => (
                <button
                  key={img.url}
                  onClick={() => setImageIndex(i)}
                  className={`h-20 w-16 overflow-hidden rounded-lg border-2 ${
                    i === imageIndex ? 'border-brand-600' : 'border-transparent'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ---------------- Info ---------------- */}
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            {product.brand}
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">{product.title}</h1>
          <p className="mt-1 text-xs text-gray-500">
            Sold by <span className="font-medium">{product.sellerShopName}</span>
          </p>

          {product.ratingCount > 0 && product.ratingAvg != null && (
            <p className="mt-2 text-sm text-gray-600">
              ★ {product.ratingAvg.toFixed(1)} · {product.ratingCount} reviews
            </p>
          )}

          {selected && (
            <div className="mt-4 flex items-baseline gap-3">
              <span className="text-3xl font-bold">{formatPaise(selected.pricePaise)}</span>
              {selected.mrpPaise && off && (
                <>
                  <span className="text-gray-400 line-through">
                    {formatPaise(selected.mrpPaise)}
                  </span>
                  <span className="font-semibold text-green-600">{off}% off</span>
                </>
              )}
            </div>
          )}

          <div className="mt-6">
            <h3 className="text-sm font-semibold">
              Colour: <span className="font-normal text-gray-600">{color}</span>
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {colorOptions.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setColor(c);
                    setSize(null);
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${
                    c === color
                      ? 'border-brand-600 bg-brand-100 font-semibold text-brand-600'
                      : 'border-gray-300 text-gray-700 hover:border-brand-600'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5">
            <h3 className="text-sm font-semibold">Size</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {sizeOptions.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setSize(v.size)}
                  disabled={v.stock === 0}
                  className={`min-w-12 rounded-lg border px-3 py-1.5 text-sm ${
                    selected?.id === v.id
                      ? 'border-brand-600 bg-brand-100 font-semibold text-brand-600'
                      : v.stock === 0
                        ? 'border-gray-200 text-gray-300 line-through'
                        : 'border-gray-300 text-gray-700 hover:border-brand-600'
                  }`}
                >
                  {v.size}
                </button>
              ))}
            </div>
            {selected && selected.stock > 0 && selected.stock <= 5 && (
              <p className="mt-2 text-xs font-medium text-orange-600">
                Only {selected.stock} left in stock
              </p>
            )}
          </div>

          <button
            onClick={() => setTryOnOpen(true)}
            className="mt-7 w-full rounded-lg bg-gradient-to-r from-purple-600 to-brand-600 py-2.5 text-sm font-semibold text-white shadow hover:opacity-90"
          >
            ✨ Try On Me — see it on yourself
          </button>

          <div className="mt-3 flex gap-3">
            <AddToCartButton variantId={selected?.id ?? null} stock={selected?.stock ?? 0} />
            <WishlistButton productId={product.id} initialInWishlist={inWishlist} variant="button" />
          </div>

          {tryOnOpen && (
            <TryOnModal
              productId={product.id}
              productTitle={product.title}
              onClose={() => setTryOnOpen(false)}
            />
          )}

          <div className="mt-8 border-t border-gray-200 pt-5">
            <h3 className="text-sm font-semibold">Product details</h3>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-gray-600">
              {product.description}
            </p>
            {selected && <p className="mt-3 text-xs text-gray-400">SKU: {selected.sku}</p>}
          </div>
        </div>
      </div>

      <RelatedProducts categorySlug={product.category.slug} excludeId={product.id} />

      <ReviewsSection productId={product.id} />
    </main>
  );
}
