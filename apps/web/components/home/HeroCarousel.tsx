'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HomeBannerView } from '@clowe/shared';
import { safeHref } from '@clowe/shared';
import { ArtPanel } from '@/components/DesignedArt';
import BannerPicture from '@/components/BannerPicture';

/** The art panel's icon: from where the banner leads, else one of a few in turn. */
function heroIcon(href: string | null | undefined, i: number): string {
  if (href?.startsWith('/tryon')) return '🪞';
  if (href?.includes('category=electronics') || href?.includes('category=mobiles')) return '📱';
  if (href?.includes('category=fashion')) return '👗';
  return ['🛍️', '✨', '📦'][i % 3]!;
}

const AI_PILLS = [
  { icon: '✦', label: 'AI Recommendations', href: '/products' },
  { icon: '⌕', label: 'AI Search', href: '/products' },
  { icon: '✨', label: 'AI Try-On', href: '/tryon' },
  { icon: '💬', label: 'AI Assistant', href: '/pages/help' },
];

const ROTATE_MS = 5500;

/**
 * The hero picture, by width. Phones: the slide's own 4:5 phone image, or
 * without one the right-hand part of the computer image (where the products
 * and people are) as a square, above the words. Tablets: the whole 16:9
 * picture above the words. From 1024px: the picture fills the card behind the
 * words, anchored right, the card keeping the picture's 16:9 so nothing is
 * cut; the words sit on the plain cream the picture leaves on its left.
 */
export function heroPictureClass(mobileImageUrl: string | null | undefined): string {
  const phone = mobileImageUrl ? 'aspect-[4/5]' : 'aspect-square object-right';
  return `mx-auto block w-full max-w-sm rounded-2xl object-cover shadow-lg ${phone} sm:max-w-lg sm:aspect-video sm:object-center lg:h-full lg:max-w-none lg:aspect-auto lg:rounded-none lg:object-right lg:shadow-none`;
}

/** Headline with the admin-chosen word rendered in gold. */
function Headline({ text, highlight }: { text: string; highlight: string | null }) {
  if (!highlight || !text.includes(highlight)) {
    return <>{text}</>;
  }
  const idx = text.indexOf(highlight);
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-brand-600">{highlight}</span>
      {text.slice(idx + highlight.length)}
    </>
  );
}

/** A designed slide's words: headline, subtext, buttons and the AI chips. */
function HeroCopy({ banner }: { banner: HomeBannerView }) {
  return (
    <>
      <h1 className="font-display text-3xl font-bold leading-tight text-ink-900 sm:text-4xl xl:text-5xl">
        <Headline text={banner.headline} highlight={banner.highlight} />
      </h1>
      {banner.subtext && <p className="mt-4 max-w-md text-sm leading-relaxed text-gray-600">{banner.subtext}</p>}
      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href={safeHref(banner.primaryHref) ?? '/products'}
          className="rounded-lg bg-ink-900 px-6 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          {banner.primaryLabel}
        </Link>
        {banner.secondaryLabel && safeHref(banner.secondaryHref) && (
          <Link
            href={safeHref(banner.secondaryHref) ?? '/products'}
            className="rounded-lg border border-brand-600 bg-white/60 px-6 py-3 text-sm font-bold uppercase tracking-wide text-brand-600 hover:bg-brand-50"
          >
            {banner.secondaryLabel}
          </Link>
        )}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {AI_PILLS.map((pill) => (
          <Link
            key={pill.label}
            // eslint-disable-next-line no-restricted-syntax -- route from a table defined in code, not data
            href={pill.href}
            className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-gray-700 backdrop-blur transition hover:border-brand-600 hover:text-brand-600"
          >
            <span className="text-brand-600">{pill.icon}</span>
            {pill.label}
          </Link>
        ))}
      </div>
    </>
  );
}

export default function HeroCarousel({ banners }: { banners: HomeBannerView[] }) {
  const [active, setActive] = useState(0);
  const hoverRef = useRef(false);

  const next = useCallback(
    () => setActive((v) => (v + 1) % Math.max(banners.length, 1)),
    [banners.length],
  );
  const prev = () => setActive((v) => (v - 1 + banners.length) % banners.length);

  // Auto-rotate, paused while hovered.
  useEffect(() => {
    if (banners.length < 2) return;
    const timer = setInterval(() => {
      if (!hoverRef.current) next();
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [banners.length, next]);

  if (banners.length === 0) return null;

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-cream-100"
      onMouseEnter={() => (hoverRef.current = true)}
      onMouseLeave={() => (hoverRef.current = false)}
      aria-roledescription="carousel"
    >
      <div
        className="flex transition-transform duration-500"
        style={{ transform: `translateX(-${active * 100}%)` }}
      >
        {banners.map((banner, i) =>
          banner.imageMode === 'FULL_IMAGE' && banner.imageUrl ? (
            // The image is the banner: one link, nothing of ours drawn on it.
            <Link
              key={banner.id}
              href={safeHref(banner.primaryHref) ?? '/products'}
              className="block w-full shrink-0"
              data-banner-full
            >
              <BannerPicture
                src={banner.imageUrl}
                mobileSrc={banner.mobileImageUrl}
                alt={banner.altText ?? banner.headline}
                loading={i === 0 ? 'eager' : 'lazy'}
                // A phone image is 4:5; without one the computer image shows whole.
                className={`block w-full object-cover ${banner.mobileImageUrl ? 'aspect-[4/5] sm:aspect-[8/3]' : 'aspect-[8/3]'}`}
              />
            </Link>
          ) : (
          <div key={banner.id} className={`relative w-full shrink-0 ${banner.imageUrl ? 'lg:aspect-video' : ''}`}>
            {banner.imageUrl ? (
              <>
                <div className="px-7 pt-7 sm:px-10 sm:pt-10 lg:absolute lg:inset-0 lg:p-0">
                  <BannerPicture
                    src={banner.imageUrl}
                    mobileSrc={banner.mobileImageUrl}
                    alt=""
                    loading={i === 0 ? 'eager' : 'lazy'}
                    className={heroPictureClass(banner.mobileImageUrl)}
                  />
                </div>
                {/* A soft cream fade behind the words, over the picture's plain left side. */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-0 hidden w-3/5 bg-gradient-to-r from-cream-100/80 via-cream-100/40 to-transparent lg:block"
                />
                <div className="relative p-7 sm:p-10 lg:flex lg:h-full lg:max-w-[46%] lg:flex-col lg:justify-center lg:py-12 lg:pl-14 lg:pr-0">
                  <HeroCopy banner={banner} />
                </div>
              </>
            ) : (
              <div className="grid items-center gap-6 p-7 sm:p-10 lg:grid-cols-2 lg:gap-10">
                <div>
                  <HeroCopy banner={banner} />
                </div>
                <div className="hidden justify-end lg:flex">
                  {/* Until a banner image is uploaded in admin: designed, not blank. */}
                  <ArtPanel
                    icon={heroIcon(banner.primaryHref, i)}
                    caption={banner.highlight?.replace(/[.!]+$/, '')}
                    className="h-72 w-full max-w-lg shadow-lg"
                  />
                </div>
              </div>
            )}
          </div>
          ),
        )}
      </div>

      {banners.length > 1 && (
        <>
          <button
            onClick={prev}
            aria-label="Previous slide"
            className="absolute left-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow transition hover:bg-white sm:flex"
          >
            ‹
          </button>
          <button
            onClick={next}
            aria-label="Next slide"
            className="absolute right-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow transition hover:bg-white sm:flex"
          >
            ›
          </button>
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1.5">
            {banners.map((b, i) => (
              <button
                key={b.id}
                onClick={() => setActive(i)}
                aria-label={`Slide ${i + 1}`}
                className={`h-2 rounded-full transition-all ${
                  i === active ? 'w-5 bg-brand-600' : 'w-2 bg-gray-300 hover:bg-gray-400'
                }`}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
