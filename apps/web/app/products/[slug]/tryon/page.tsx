'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  TRYON_PHOTO_MAX_BYTES,
  type CategoryNode,
  type ProductDetail,
  type TryOnFeedback,
  type TryOnHistoryRow,
  type TryOnQuota,
  type TryOnResult,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser, uploadImages } from '@/lib/api';
import { getPublicSettings } from '@/lib/settings';
import { discountPercent, formatPaise } from '@/lib/format';
import { colorToHex } from '@/lib/colors';
import AddToCartButton from '@/components/AddToCartButton';
import WishlistButton from '@/components/WishlistButton';
import RelatedProducts from '@/components/RelatedProducts';
import SizeGuideModal from '@/components/product/SizeGuideModal';
import { fetchWishlistIds } from '@/lib/wishlist';
import { LockIcon, ShieldCheckIcon } from '@/components/cart/CartIcons';

const PHOTO_TIPS = ['Good lighting', 'Facing forward', 'Arms visible', 'Plain background'];

const FEATURES = [
  {
    icon: '🪞',
    title: 'Realistic Fit Visualization',
    text: 'AI shows how the product looks on you',
  },
  { icon: '🗂', title: 'Every Run Saved', text: 'Flip between all your try-ons for this item' },
  { icon: '🔒', title: 'Private to You', text: 'Your photo is never shown to sellers' },
  { icon: '⚡', title: 'Quick & Easy', text: 'Get results in under a minute' },
];

/** Numbered section shell matching the left rail cards. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
      <h2 className="flex items-center gap-2.5 text-sm font-bold text-ink-900">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-3xl bg-white p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="How AI Try-On works"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">How AI Try-On works</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-xl leading-none text-gray-400 hover:bg-gray-100"
          >
            ×
          </button>
        </div>
        <ol className="mt-4 space-y-3 text-sm text-gray-600">
          {[
            'Upload a clear, front-facing photo of yourself.',
            'Pick the size and colour you want to see.',
            'Our AI places the product on your photo — this takes a few seconds.',
            'Flip through your saved results, rate the fit, then add to cart.',
          ].map((line, i) => (
            <li key={line} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cream-100 text-xs font-bold text-ink-900">
                {i + 1}
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ol>
        <p className="mt-4 rounded-lg bg-cream-50 px-3 py-2 text-xs text-gray-500">
          Your photo is saved to your account so you don&apos;t have to upload it again. You can
          delete it any time from this page.
        </p>
        <button
          onClick={onClose}
          className="mt-4 w-full rounded-lg bg-ink-900 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          Got it
        </button>
      </div>
    </div>
  );
}

export default function TryOnPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  const router = useRouter();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [quota, setQuota] = useState<TryOnQuota | null>(null);
  const [minPaise, setMinPaise] = useState<number | null>(null);
  const [inWishlist, setInWishlist] = useState(false);

  const [size, setSize] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [dragging, setDragging] = useState(false);

  const [runs, setRuns] = useState<TryOnHistoryRow[]>([]);
  const [activeRun, setActiveRun] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadRuns = useCallback((productId: string) => {
    api<TryOnHistoryRow[]>(`/api/tryon/history?productId=${productId}`, { auth: true })
      .then((rows) => {
        // Oldest → newest so the newest lands last in the strip.
        const done = rows.filter((r) => r.status === 'SUCCESS' && r.resultImageUrl).reverse();
        setRuns(done);
        setActiveRun(Math.max(0, done.length - 1));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!getStoredUser()) {
      router.replace('/login');
      return;
    }
    api<CategoryNode[]>('/api/categories').then(setCategories).catch(() => {});
    api<TryOnQuota>('/api/tryon/quota', { auth: true }).then(setQuota).catch(() => {});
    getPublicSettings()
      .then((s) => setMinPaise(s.tryonMinPricePaise))
      .catch(() => setMinPaise(0));
    api<ProductDetail>(`/api/products/${slug}`)
      .then((p) => {
        setProduct(p);
        setColor(p.variants[0]?.color ?? null);
        loadRuns(p.id);
        fetchWishlistIds().then((ids) => setInWishlist(ids.has(p.id)));
      })
      .catch(() => setNotFound(true));
  }, [slug, router, loadRuns]);

  useEffect(() => {
    if (!photoFile) return;
    const url = URL.createObjectURL(photoFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

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

  const savedPhotoUrl = quota?.savedPhotoUrl ?? null;
  const effectivePhoto = photoFile ? previewUrl : savedPhotoUrl;
  const remaining = quota ? Math.max(0, quota.dailyLimit - quota.usedToday) : null;
  const current = runs[activeRun] ?? null;

  function pickFile(file: File | null | undefined) {
    if (!file) return;
    if (file.size > TRYON_PHOTO_MAX_BYTES) {
      setError(`That photo is too large — keep it under ${TRYON_PHOTO_MAX_BYTES / (1024 * 1024)} MB.`);
      return;
    }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setError('Please pick a JPG, PNG or WEBP image.');
      return;
    }
    setError('');
    setPhotoFile(file);
  }

  async function generate() {
    if (!product || (!photoFile && !savedPhotoUrl)) return;
    setError('');
    setGenerating(true);
    try {
      let photoUrl = savedPhotoUrl!;
      if (photoFile) {
        [photoUrl] = await uploadImages([photoFile]);
        // Remember the photo so the next try-on is one click.
        void api('/api/tryon/photo', { body: { photoUrl }, auth: true }).catch(() => {});
      }
      const data = await api<TryOnResult>('/api/tryon', {
        body: {
          productId: product.id,
          photoUrl,
          ...(selected ? { variantSize: selected.size, variantColor: selected.color } : {}),
        },
        auth: true,
      });
      if (data.status === 'FAILED') {
        setError(data.errorMessage ?? 'Try-on failed. Please try another photo.');
        return;
      }
      setPhotoFile(null);
      loadRuns(product.id);
      api<TryOnQuota>('/api/tryon/quota', { auth: true }).then(setQuota).catch(() => {});
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setGenerating(false);
    }
  }

  async function rate(feedback: TryOnFeedback) {
    if (!current) return;
    const next = current.feedback === feedback ? null : feedback;
    setRuns((prev) => prev.map((r) => (r.id === current.id ? { ...r, feedback: next } : r)));
    try {
      await api(`/api/tryon/${current.id}/feedback`, { body: { feedback: next }, auth: true });
    } catch {
      setError('Could not save your feedback');
    }
  }

  async function forgetPhoto() {
    try {
      await api('/api/tryon/photo', { method: 'DELETE', auth: true });
      setQuota((q) => (q ? { ...q, savedPhotoUrl: null } : q));
      setPhotoFile(null);
    } catch {
      setError('Could not remove your saved photo');
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
        <div className="h-8 w-48 rounded-lg bg-cream-100" />
        <div className="mt-5 grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)_20rem]">
          <div className="h-96 rounded-2xl bg-cream-100" />
          <div className="h-96 rounded-2xl bg-cream-100" />
          <div className="h-80 rounded-2xl bg-cream-100" />
        </div>
      </main>
    );
  }

  const eligible =
    product.tryOnEligible &&
    minPaise !== null &&
    Math.min(...product.variants.map((v) => v.pricePaise)) >= minPaise;

  if (minPaise !== null && !eligible) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <span className="text-5xl">🪞</span>
        <h1 className="mt-4 font-display text-2xl font-bold text-ink-900">
          Try-On isn&apos;t available for this product
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          AI Try-On works on fashion items priced {formatPaise(minPaise)} and above.
        </p>
        <Link
          href={`/products/${product.slug}`}
          className="mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          Back to product
        </Link>
      </main>
    );
  }

  const rootCategory = categories.find((c) => c.slug === product.rootCategorySlug);

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
        <Link
          href={`/category/${product.rootCategorySlug}?category=${product.category.slug}`}
          className="hover:text-brand-600"
        >
          {product.category.name}
        </Link>
        <span>›</span>
        <Link href={`/products/${product.slug}`} className="truncate hover:text-brand-600">
          {product.title}
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Try-On</span>
      </nav>

      {/* Title */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-page-title flex items-center gap-2 text-ink-900">✨ AI Try-On</h1>
          <p className="t-hero-desc mt-1 text-gray-500">
            See how this {product.category.name.toLowerCase()} looks on you. Realistic. Accurate.
            Effortless.
          </p>
        </div>
        <button
          onClick={() => setHowOpen(true)}
          className="flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline"
        >
          ▶ How it works?
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 grid items-start gap-5 lg:grid-cols-[19rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)_21rem]">
        {/* ── Left: inputs ──────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Step n={1} title="Upload Your Photo">
            <p className="mt-2 text-xs text-gray-500">
              Upload a clear front photo for best results.
            </p>

            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files?.[0]);
              }}
              className={`mt-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-7 text-center transition ${
                dragging
                  ? 'border-brand-600 bg-brand-50'
                  : 'border-brand-200 bg-brand-50/30 hover:border-brand-600'
              }`}
            >
              <span className="text-2xl text-brand-600">⬆</span>
              <span className="mt-1.5 text-sm font-bold text-brand-600">Click to upload</span>
              <span className="text-xs text-gray-500">or drag and drop</span>
              <span className="mt-1.5 text-[11px] text-gray-400">
                JPG, PNG or WEBP (max {TRYON_PHOTO_MAX_BYTES / (1024 * 1024)}MB)
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
            </label>

            <div className="mt-4 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-ink-900">Best results with</p>
                <ul className="mt-1.5 space-y-1">
                  {PHOTO_TIPS.map((tip) => (
                    <li key={tip} className="flex items-center gap-1.5 text-xs text-gray-600">
                      <span className="font-bold text-green-600">✓</span>
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
              {effectivePhoto && (
                <div className="shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={effectivePhoto}
                    alt="Your photo"
                    className="h-24 w-20 rounded-lg border border-gray-200 object-cover"
                  />
                  <p className="mt-1 text-center text-[10px] text-gray-400">
                    {photoFile ? 'New photo' : 'Saved'}
                  </p>
                </div>
              )}
            </div>

            {savedPhotoUrl && !photoFile && (
              <button
                onClick={() => void forgetPhoto()}
                className="mt-2 text-[11px] font-medium text-gray-400 underline hover:text-red-600"
              >
                Delete my saved photo
              </button>
            )}
          </Step>

          <Step n={2} title="Select Size">
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {sizeOptions.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setSize(v.size)}
                    disabled={v.stock === 0}
                    className={`min-w-11 rounded-lg border px-3 py-1.5 text-sm transition ${
                      selected?.id === v.id
                        ? 'border-brand-600 bg-brand-50 font-bold text-brand-700'
                        : v.stock === 0
                          ? 'border-gray-200 text-gray-300 line-through'
                          : 'border-gray-300 text-gray-700 hover:border-brand-600'
                    }`}
                  >
                    {v.size}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setSizeGuideOpen(true)}
                className="shrink-0 text-xs font-semibold text-brand-600 hover:underline"
              >
                ✎ Size Guide
              </button>
            </div>
          </Step>

          <Step n={3} title="Select Color">
            <div className="mt-3 flex flex-wrap gap-2.5">
              {colorOptions.map((c) => {
                const hex = colorToHex(c);
                const active = c === color;
                return (
                  <button
                    key={c}
                    onClick={() => {
                      setColor(c);
                      setSize(null);
                    }}
                    title={c}
                    aria-label={c}
                    className={`flex h-9 w-9 items-center justify-center rounded-full border-2 transition ${
                      active
                        ? 'border-brand-600 ring-2 ring-brand-100'
                        : 'border-gray-200 hover:border-gray-400'
                    }`}
                    style={hex ? { backgroundColor: hex } : undefined}
                  >
                    {!hex && (
                      <span className="text-[10px] font-bold text-gray-600">{c.slice(0, 2)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </Step>

          <div className="flex items-start gap-3 rounded-2xl border border-gray-100 bg-white p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cream-100 text-xs font-bold text-ink-900">
              AI
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-ink-900">
                Powered by {quota?.provider === 'mock' ? 'AI (mock mode)' : 'AI'}
              </p>
              <p className="text-xs text-gray-500">
                {quota?.provider === 'mock'
                  ? 'Dev provider — results are simulated, not a real fitting.'
                  : 'Advanced AI technology for a realistic try-on experience.'}
              </p>
            </div>
          </div>
        </div>

        {/* ── Centre: preview ───────────────────────────────────────────── */}
        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-ink-900">Try-On Preview</h2>
            {remaining !== null && (
              <span className="rounded-md bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-700">
                {remaining} of {quota?.dailyLimit} left today
              </span>
            )}
          </div>

          <div className="relative mt-3 flex min-h-[22rem] items-center justify-center overflow-hidden rounded-xl bg-cream-100 sm:min-h-[28rem]">
            {generating ? (
              <div className="flex flex-col items-center py-16">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand-100 border-t-brand-600" />
                <p className="mt-4 text-sm font-medium text-gray-700">Creating your try-on…</p>
                <p className="mt-1 text-xs text-gray-400">This can take up to a minute</p>
              </div>
            ) : current?.resultImageUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={current.resultImageUrl}
                  alt="Your try-on result"
                  className="max-h-[28rem] w-full object-contain"
                />
                {runs.length > 1 && (
                  <>
                    <button
                      onClick={() => setActiveRun((i) => (i - 1 + runs.length) % runs.length)}
                      aria-label="Previous result"
                      className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 shadow-md hover:bg-white"
                    >
                      ‹
                    </button>
                    <button
                      onClick={() => setActiveRun((i) => (i + 1) % runs.length)}
                      aria-label="Next result"
                      className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 shadow-md hover:bg-white"
                    >
                      ›
                    </button>
                  </>
                )}
              </>
            ) : (
              <div className="px-6 py-16 text-center">
                <span className="text-4xl">🪞</span>
                <p className="mt-3 text-sm font-semibold text-ink-900">
                  Your try-on will appear here
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {effectivePhoto
                    ? 'Pick a size and colour, then generate.'
                    : 'Upload a photo to get started.'}
                </p>
              </div>
            )}
          </div>

          {/* Result strip — every run you've made on this product */}
          {runs.length > 0 && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {runs.map((run, i) => (
                <button
                  key={run.id}
                  onClick={() => setActiveRun(i)}
                  className={`w-20 shrink-0 rounded-lg border-2 p-1 text-center transition ${
                    i === activeRun ? 'border-brand-600' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={run.resultImageUrl ?? ''}
                    alt=""
                    loading="lazy"
                    className="h-20 w-full rounded object-cover"
                  />
                  <span className="mt-1 block truncate text-[10px] text-gray-500">
                    {[run.variantColor, run.variantSize].filter(Boolean).join(' / ') ||
                      `Run ${i + 1}`}
                  </span>
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => void generate()}
            disabled={generating || (!photoFile && !savedPhotoUrl) || remaining === 0}
            className="mt-4 w-full rounded-lg bg-brand-600 py-3 text-sm font-bold text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            {generating
              ? 'Generating…'
              : remaining === 0
                ? 'Daily limit reached — try again tomorrow'
                : runs.length > 0
                  ? '✨ Generate another try-on'
                  : '✨ Generate my try-on'}
          </button>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[11px] text-gray-400">
            <LockIcon className="h-3.5 w-3.5" />
            AI results may vary slightly from the actual product.
          </p>
        </section>

        {/* ── Right: product + actions ──────────────────────────────────── */}
        <aside className="space-y-4 lg:col-span-2 xl:col-span-1">
          <div className="relative rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">Product</p>
            <WishlistButton productId={product.id} initialInWishlist={inWishlist} />
            <div className="mt-3 flex gap-3">
              {product.images[0] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={product.images[0].url}
                  alt=""
                  className="h-20 w-16 shrink-0 rounded-lg bg-cream-100 object-cover"
                />
              )}
              <div className="min-w-0">
                <p className="line-clamp-2 text-sm font-semibold text-ink-900">{product.title}</p>
                {selected && (
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-bold text-ink-900">
                      {formatPaise(selected.pricePaise)}
                    </span>
                    {selected.mrpPaise && off && (
                      <>
                        <span className="text-xs text-gray-400 line-through">
                          {formatPaise(selected.mrpPaise)}
                        </span>
                        <span className="text-xs font-bold text-brand-600">{off}% OFF</span>
                      </>
                    )}
                  </p>
                )}
                {selected && (
                  <p className="mt-0.5 text-xs text-gray-500">
                    Color: {selected.color}
                    {selected.size ? ` | Size: ${selected.size}` : ''}
                  </p>
                )}
              </div>
            </div>
            <Link
              href={`/products/${product.slug}`}
              className="mt-3 inline-block text-xs font-semibold text-brand-600 hover:underline"
            >
              View Product Details ↗
            </Link>
          </div>

          {current && (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-white p-4">
              <p className="text-sm font-bold text-ink-900">Happy with the fit?</p>
              <div className="flex gap-2">
                <button
                  onClick={() => void rate('UP')}
                  aria-label="Good fit"
                  aria-pressed={current.feedback === 'UP'}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                    current.feedback === 'UP'
                      ? 'border-green-600 bg-green-50 text-green-700'
                      : 'border-gray-200 text-gray-500 hover:border-green-500'
                  }`}
                >
                  👍
                </button>
                <button
                  onClick={() => void rate('DOWN')}
                  aria-label="Poor fit"
                  aria-pressed={current.feedback === 'DOWN'}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                    current.feedback === 'DOWN'
                      ? 'border-red-500 bg-red-50 text-red-600'
                      : 'border-gray-200 text-gray-500 hover:border-red-400'
                  }`}
                >
                  👎
                </button>
              </div>
            </div>
          )}

          <div className="space-y-3 rounded-2xl border border-gray-100 bg-white p-4">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="flex items-start gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cream-100 text-sm">
                  {feature.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-ink-900">{feature.title}</p>
                  <p className="text-[11px] text-gray-500">{feature.text}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2.5">
            <div className="flex gap-3">
              <AddToCartButton variantId={selected?.id ?? null} stock={selected?.stock ?? 0} />
            </div>
            <div className="flex gap-3">
              <AddToCartButton
                variantId={selected?.id ?? null}
                stock={selected?.stock ?? 0}
                mode="buy"
              />
            </div>
            <button
              onClick={() => {
                setPhotoFile(null);
                setError('');
                fileInputRef.current?.click();
              }}
              className="w-full rounded-lg border border-brand-600 py-3 text-sm font-bold text-brand-600 transition hover:bg-brand-50"
            >
              ⟳ Try Another Photo
            </button>
            {current?.resultImageUrl && (
              <a
                href={current.resultImageUrl}
                download="clowe-tryon"
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg border border-gray-300 py-3 text-center text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                ⬇ Download result
              </a>
            )}
            <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-gray-400">
              <ShieldCheckIcon className="h-3.5 w-3.5" />
              Your photo stays private to your account
            </p>
          </div>
        </aside>
      </div>

      {sizeGuideOpen && (
        <SizeGuideModal
          sizes={[...new Set(product.variants.map((v) => v.size))]}
          selectedSize={selected?.size ?? null}
          onClose={() => setSizeGuideOpen(false)}
        />
      )}
      {howOpen && <HowItWorks onClose={() => setHowOpen(false)} />}

      <RelatedProducts categorySlug={product.category.slug} excludeId={product.id} />
    </main>
  );
}
