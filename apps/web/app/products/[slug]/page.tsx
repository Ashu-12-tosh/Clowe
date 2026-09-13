'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { CategoryNode, ProductDetail, ProductVariantInfo, PdpOffer } from '@clowe/shared';
import { api } from '@/lib/api';
import { recordRecentlyViewed } from '@/lib/recentlyViewed';
import { fetchWishlistIds } from '@/lib/wishlist';
import { discountPercent, formatPaise } from '@/lib/format';
import WishlistButton from '@/components/WishlistButton';
import AddToCartButton from '@/components/AddToCartButton';
import { colorToHex } from '@/lib/colors';
import ReviewsSection from '@/components/ReviewsSection';
import RelatedProducts from '@/components/RelatedProducts';
import DeliveryCard from '@/components/product/DeliveryCard';
import OffersCard from '@/components/product/OffersCard';
import SizeGuideModal from '@/components/product/SizeGuideModal';
import TryOnPanel from '@/components/product/TryOnPanel';
import { getPublicSettings } from '@/lib/settings';
import {
  BoxIcon,
  HeadsetIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

/** "12K+ Sold" / "845 Sold". */
function compactCount(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K+`;
  return String(n);
}

/** Image with hover-to-zoom (desktop): magnifies around the cursor. */
function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState('center');
  const [zoomed, setZoomed] = useState(false);

  return (
    <div
      ref={ref}
      className="relative aspect-square cursor-zoom-in overflow-hidden rounded-2xl bg-cream-100"
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

/** Star row, e.g. ★ 4.6 (2.4K Ratings) | 12K+ Sold. */
function RatingLine({ avg, count, sold }: { avg: number; count: number; sold: number }) {
  const ratings = count >= 1000 ? `${(count / 1000).toFixed(1)}K` : String(count);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="flex items-center gap-1 rounded bg-green-600 px-1.5 py-0.5 text-xs font-bold text-white">
        {avg.toFixed(1)} ★
      </span>
      <span className="text-gray-500">({ratings} Ratings)</span>
      {sold > 0 && (
        <>
          <span className="text-gray-300">|</span>
          <span className="text-gray-500">{compactCount(sold)} Sold</span>
        </>
      )}
    </p>
  );
}

/** Variant to preselect: cheapest in-stock one, else the first. */
function defaultVariant(variants: ProductVariantInfo[]): ProductVariantInfo | null {
  const inStock = variants.filter((v) => v.stock > 0);
  const pool = inStock.length ? inStock : variants;
  return pool.reduce<ProductVariantInfo | null>(
    (min, v) => (!min || v.pricePaise < min.pricePaise ? v : min),
    null,
  );
}

export default function ProductDetailPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [inWishlist, setInWishlist] = useState(false);
  const [imageIndex, setImageIndex] = useState(0);
  /** Chosen value per option axis, e.g. { color: "Black", size: "L" }. */
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);
  // ?tryon=1 opens the panel on arrival, so a "Try On" link from elsewhere
  // (the wishlist, a campaign) lands on the product with it already open.
  const [tryOnOpen, setTryOnOpen] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tryon') === '1') setTryOnOpen(true);
  }, []);
  const [shared, setShared] = useState(false);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  // Try-On is premium-only; threshold comes from admin settings (paise).
  const [tryonMinPaise, setTryonMinPaise] = useState<number | null>(null);
  const [offers, setOffers] = useState<PdpOffer[]>([]);

  useEffect(() => {
    getPublicSettings()
      .then((s) => {
        setTryonMinPaise(s.tryonMinPricePaise);
        setOffers(s.pdpOffers);
      })
      .catch(() => setTryonMinPaise(0)); // fail open for display only — server still enforces
    api<CategoryNode[]>('/api/categories').then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    setProduct(null);
    setImageIndex(0);
    // auth: true so a signed-in view is attributed to this shopper — the
    // endpoint is public, but without the token every view landed on the
    // server as anonymous and "Recently viewed" stayed empty.
    api<ProductDetail>(`/api/products/${slug}`, { auth: true })
      .then((p) => {
        setProduct(p);
        setSelection({ ...(defaultVariant(p.variants)?.optionValues ?? {}) });
        recordRecentlyViewed(p.id);
        fetchWishlistIds().then((ids) => setInWishlist(ids.has(p.id)));
      })
      .catch(() => setNotFound(true));
  }, [slug]);

  const axes = useMemo(() => product?.variantAxes ?? [], [product]);

  // The variant whose options match every current choice.
  const selected = useMemo(() => {
    if (!product) return null;
    return (
      product.variants.find((v) =>
        axes.every((a) => (v.optionValues[a.key] ?? '') === (selection[a.key] ?? '')),
      ) ?? null
    );
  }, [product, axes, selection]);
  const off = selected ? discountPercent(selected.pricePaise, selected.mrpPaise) : null;

  /** Distinct values of one axis, in the API's (sorted) order. */
  const valuesFor = (key: string): string[] =>
    [...new Set(product?.variants.map((v) => v.optionValues[key]).filter(Boolean) ?? [])];

  /** Pick one value; other axes follow to the nearest in-stock variant that has it. */
  function choose(key: string, value: string) {
    if (!product) return;
    const next = { ...selection, [key]: value };
    const exact = product.variants.find((v) =>
      axes.every((a) => (v.optionValues[a.key] ?? '') === (next[a.key] ?? '')),
    );
    if (exact) {
      setSelection(next);
      return;
    }
    const candidates = product.variants.filter((v) => v.optionValues[key] === value);
    const fallback =
      candidates.find((v) => v.stock > 0) ?? candidates[0] ?? null;
    if (fallback) setSelection({ ...fallback.optionValues });
  }

  // Breadcrumb: Home > Root > Subcategory > Product.
  const rootCategory = categories.find((c) => c.slug === product?.rootCategorySlug);
  const isSubcategory = product && product.category.slug !== product.rootCategorySlug;

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: product?.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch {
      // User dismissed the share sheet — nothing to report.
    }
  }

  if (notFound) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <p className="font-display text-2xl font-bold text-ink-900">Product not found</p>
        <Link
          href="/products"
          className="mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          Back to shop
        </Link>
      </main>
    );
  }

  if (!product) {
    return (
      <main className="mx-auto max-w-7xl animate-pulse px-4 py-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_20rem]">
          <div className="aspect-square rounded-2xl bg-cream-100" />
          <div className="space-y-4">
            <div className="h-6 w-2/3 rounded bg-cream-100" />
            <div className="h-4 w-1/3 rounded bg-cream-100" />
            <div className="h-10 w-1/2 rounded bg-cream-100" />
          </div>
          <div className="h-64 rounded-2xl bg-cream-100" />
        </div>
      </main>
    );
  }

  const tryOnEligible =
    product.tryOnEligible &&
    tryonMinPaise !== null &&
    Math.min(...product.variants.map((v) => v.pricePaise)) >= tryonMinPaise;
  const returnsText = `Within ${product.returnWindowDays} day${product.returnWindowDays === 1 ? '' : 's'}`;

  const trustRow = [
    { Icon: BoxIcon, title: '100% Original', text: 'Products' },
    { Icon: ReturnIcon, title: 'Easy Returns', text: returnsText },
    { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% Safe & Secure' },
    { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  ];
  const trustStrip = [
    { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
    { Icon: ReturnIcon, title: 'Easy Returns', text: `Hassle-free returns ${returnsText.toLowerCase()}` },
    { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
    { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
    { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
  ];

  return (
    <main className="mx-auto max-w-7xl px-4 pb-10 pt-4">
      {/* Breadcrumb */}
      <nav className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        {rootCategory && (
          <>
            <Link href={`/category/${rootCategory.slug}`} className="hover:text-brand-600">
              {rootCategory.name}
            </Link>
            <span>›</span>
          </>
        )}
        {isSubcategory && (
          <>
            <Link
              href={`/category/${product.rootCategorySlug}?category=${product.category.slug}`}
              className="hover:text-brand-600"
            >
              {product.category.name}
            </Link>
            <span>›</span>
          </>
        )}
        <span className="truncate font-medium text-ink-900">{product.title}</span>
      </nav>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_20rem]">
        {/* ── Gallery ────────────────────────────────────────────────────── */}
        <div className="flex gap-3">
          {product.images.length > 1 && (
            <div className="scrollbar-none flex max-h-[32rem] w-16 shrink-0 flex-col gap-2 overflow-y-auto">
              {product.images.map((img, i) => (
                <button
                  key={img.url}
                  onClick={() => setImageIndex(i)}
                  aria-label={`View image ${i + 1}`}
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition ${
                    i === imageIndex ? 'border-brand-600' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}

          <div className="relative min-w-0 flex-1">
            {product.images[imageIndex] && (
              <ZoomImage src={product.images[imageIndex].url} alt={product.title} />
            )}
            {product.isBestSeller && (
              <span className="absolute left-3 top-3 rounded-md bg-brand-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-brand-700">
                Best Seller
              </span>
            )}
            {!product.isBestSeller && product.isNew && (
              <span className="absolute left-3 top-3 rounded-md bg-ink-900 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                New
              </span>
            )}
            <WishlistButton productId={product.id} initialInWishlist={inWishlist} />
          </div>
        </div>

        {/* ── Buy box ───────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {product.brand && <p className="t-pdp-brand text-gray-500">{product.brand}</p>}
              <h1 className="t-pdp-title mt-0.5 text-ink-900">{product.title}</h1>
            </div>
            <button
              onClick={() => void share()}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:border-brand-600 hover:text-brand-600"
            >
              {shared ? '✓ Link copied' : '↗ Share'}
            </button>
          </div>

          {product.ratingCount > 0 && product.ratingAvg != null && (
            <RatingLine avg={product.ratingAvg} count={product.ratingCount} sold={product.soldCount} />
          )}

          {selected && (
            <>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="t-pdp-price text-ink-900">{formatPaise(selected.pricePaise)}</span>
                {selected.mrpPaise && off && (
                  <>
                    <span className="text-gray-400 line-through">
                      {formatPaise(selected.mrpPaise)}
                    </span>
                    <span className="text-sm font-bold text-brand-600">{off}% OFF</span>
                  </>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-400">Inclusive of all taxes</p>

              <OffersCard pricePaise={selected.pricePaise} offers={offers} />
            </>
          )}

          {/* Option axes — colour renders as swatches, everything else as chips */}
          {axes.map((axis) => {
            const values = valuesFor(axis.key);
            if (values.length === 0) return null;
            const current = selection[axis.key];
            const isColor = axis.key === 'color';
            return (
              <div key={axis.key} className={isColor ? 'mt-6' : 'mt-5'}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-bold text-ink-900">
                    {axis.label}: <span className="font-normal text-gray-600">{current}</span>
                  </h3>
                  {product.sizeGuide && axis.key === 'size' && (
                    <button
                      onClick={() => setSizeGuideOpen(true)}
                      className="text-xs font-semibold text-brand-600 hover:underline"
                    >
                      ✎ Size Guide
                    </button>
                  )}
                </div>
                <div className={`mt-2 flex flex-wrap ${isColor ? 'gap-2.5' : 'gap-2'}`}>
                  {values.map((value) => {
                    const active = value === current;
                    // Sold out on every combination that includes this value.
                    const soldOut = !product.variants.some(
                      (v) => v.optionValues[axis.key] === value && v.stock > 0,
                    );
                    if (isColor) {
                      const hex = colorToHex(value);
                      return (
                        <button
                          key={value}
                          onClick={() => choose(axis.key, value)}
                          disabled={soldOut}
                          title={soldOut ? `${value} — sold out` : value}
                          aria-label={value}
                          className={`flex h-9 w-9 items-center justify-center rounded-full border-2 transition ${
                            active
                              ? 'border-brand-600 ring-2 ring-brand-100'
                              : 'border-gray-200 hover:border-gray-400'
                          } ${soldOut ? 'opacity-40' : ''}`}
                          style={hex ? { backgroundColor: hex } : undefined}
                        >
                          {!hex && (
                            <span className="text-[10px] font-bold text-gray-600">
                              {value.slice(0, 2)}
                            </span>
                          )}
                        </button>
                      );
                    }
                    return (
                      <button
                        key={value}
                        onClick={() => choose(axis.key, value)}
                        disabled={soldOut}
                        className={`min-w-14 rounded-lg border px-3 py-2 text-sm transition ${
                          active
                            ? 'border-brand-600 bg-brand-50 font-bold text-brand-700'
                            : soldOut
                              ? 'border-gray-200 text-gray-300 line-through'
                              : 'border-gray-300 text-gray-700 hover:border-brand-600'
                        }`}
                      >
                        {value}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {selected && selected.stock > 0 && selected.stock <= 5 && (
            <p className="mt-2 text-xs font-medium text-orange-600">
              Only {selected.stock} left in stock
            </p>
          )}
          {selected && selected.stock === 0 && (
            <p className="mt-2 text-xs font-medium text-red-600">
              {axes.length ? 'This option is out of stock' : 'Out of stock'}
            </p>
          )}

          {/* CTAs */}
          <div className="mt-6 flex gap-3">
            <AddToCartButton variantId={selected?.id ?? null} stock={selected?.stock ?? 0} />
            <AddToCartButton
              variantId={selected?.id ?? null}
              stock={selected?.stock ?? 0}
              mode="buy"
            />
          </div>

          {/* Trust row */}
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-gray-100 pt-4 sm:grid-cols-4">
            {trustRow.map(({ Icon, title, text }) => (
              <div key={title} className="flex items-start gap-2">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-ink-900">{title}</p>
                  <p className="text-[11px] text-gray-500">{text}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Description */}
          <div className="mt-6 border-t border-gray-100 pt-5">
            <h3 className="text-sm font-bold text-ink-900">Product Details</h3>
            <p className="t-pdp-desc mt-2 whitespace-pre-line text-gray-600">{product.description}</p>
            {selected && (
              <p className="mt-3 text-xs text-gray-400">
                SKU: {selected.sku}
                {selected.label ? ` · ${selected.label}` : ''}
              </p>
            )}
          </div>
        </div>

        {/* ── Right rail ────────────────────────────────────────────────── */}
        <aside className="space-y-4 lg:col-span-2 xl:col-span-1">
          {tryOnEligible && (
            <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-4">
              <p className="flex items-center gap-1.5 text-sm font-bold text-ink-900">
                ✨ AI Try-On
              </p>
              <div className="mt-2 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-ink-900">See how this looks on you</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    See it on your own photo, right here.
                  </p>
                  <button
                    onClick={() => setTryOnOpen(true)}
                    className="mt-3 inline-block rounded-lg border border-brand-600 bg-white px-4 py-2 text-xs font-bold text-brand-700 transition hover:bg-brand-50"
                  >
                    Try On Now
                  </button>
                </div>
                {product.images[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={product.images[0].url}
                    alt=""
                    loading="lazy"
                    className="h-24 w-20 shrink-0 rounded-lg border border-brand-200 object-cover"
                  />
                )}
              </div>
            </div>
          )}

          <DeliveryCard subtotalPaise={selected?.pricePaise ?? 0} />

          {product.highlights.length > 0 && (
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <p className="text-sm font-bold text-ink-900">Highlights</p>
              <ul className="mt-2.5 space-y-2">
                {product.highlights.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-gray-600">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                    <span className="min-w-0">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {product.attributes.length > 0 && (
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <p className="text-sm font-bold text-ink-900">Specifications</p>
              <dl className="mt-2.5 divide-y divide-gray-50">
                {product.attributes.map((attr) => (
                  <div key={attr.name} className="flex gap-3 py-1.5 text-sm">
                    <dt className="w-36 shrink-0 text-gray-500">{attr.name}</dt>
                    <dd className="min-w-0 text-ink-900">{attr.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">Sold by</p>
            <div className="mt-3 flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cream-100 font-display text-base font-bold text-ink-900">
                {product.seller.shopName.slice(0, 1)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink-900">
                  {product.seller.shopName}
                </p>
                {(product.seller.city || product.seller.state) && (
                  <p className="truncate text-xs text-gray-500">
                    {[product.seller.city, product.seller.state].filter(Boolean).join(', ')}
                  </p>
                )}
              </div>
            </div>
            {product.seller.isVerified && (
              <span className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-700">
                <ShieldCheckIcon className="h-3.5 w-3.5" />
                Verified Seller
              </span>
            )}
          </div>
        </aside>
      </div>

      {tryOnEligible && (
        <TryOnPanel
          product={product}
          variant={selected}
          open={tryOnOpen}
          onClose={() => setTryOnOpen(false)}
        />
      )}

      {sizeGuideOpen && (
        <SizeGuideModal
          sizes={valuesFor('size')}
          selectedSize={selected?.optionValues.size ?? null}
          onClose={() => setSizeGuideOpen(false)}
        />
      )}

      <RelatedProducts categorySlug={product.category.slug} excludeId={product.id} />

      <ReviewsSection productId={product.id} />

      {/* Bottom trust strip */}
      <section className="mt-8 grid gap-3 rounded-2xl bg-cream-50 p-5 sm:grid-cols-2 lg:grid-cols-5">
        {trustStrip.map(({ Icon, title, text }) => (
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
