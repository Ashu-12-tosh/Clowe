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
 * Every slide is one fixed height per width, so the carousel never changes
 * size as it turns (the owner's call): 340px from 768px, 380px from 1024px,
 * 440px from 1280px. Below 768px the picture sits above the words.
 */
export const HERO_SLIDE_HEIGHT = 'md:h-[340px] lg:h-[380px] xl:h-[440px]';

/**
 * The hero picture, by width. Phones: a 220px-high band of the slide's 4:5
 * phone image (its lower part, where the products are), or of the computer
 * image anchored right, above the words. From 768px: the picture fills the
 * slide behind the words, cropped to the slide's height and anchored right;
 * the words sit on the plain cream the picture leaves on its left.
 */
export function heroPictureClass(mobileImageUrl: string | null | undefined): string {
  const phone = mobileImageUrl ? 'object-[50%_75%]' : 'object-right';
  return `block h-[220px] w-full rounded-2xl object-cover shadow-lg ${phone} md:h-full md:rounded-none md:object-[100%_60%] md:shadow-none`;
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
      <h1 className="line-clamp-2 font-display text-2xl font-bold leading-tight text-ink-900 sm:text-3xl lg:text-4xl xl:text-5xl">
        <Headline text={banner.headline} highlight={banner.highlight} />
      </h1>
      {banner.subtext && <p className="mt-3 line-clamp-2 max-w-md text-sm leading-relaxed text-gray-600 xl:mt-4">{banner.subtext}</p>}
      <div className="mt-4 flex flex-wrap gap-3 xl:mt-6">
        <Link
          href={safeHref(banner.primaryHref) ?? '/products'}
          className="rounded-lg bg-ink-900 px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 xl:px-6 xl:py-3"
        >
          {banner.primaryLabel}
        </Link>
        {banner.secondaryLabel && safeHref(banner.secondaryHref) && (
          <Link
            href={safeHref(banner.secondaryHref) ?? '/products'}
            className="rounded-lg border border-brand-600 bg-white/60 px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-brand-600 hover:bg-brand-50 xl:px-6 xl:py-3"
          >
            {banner.secondaryLabel}
          </Link>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-2 xl:mt-6" data-hero-chips>
        {AI_PILLS.map((pill) => (
          <Link
            key={pill.label}
            // eslint-disable-next-line no-restricted-syntax -- route from a table defined in code, not data
            href={pill.href}
            className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-white/70 px-3 py-1 text-xs font-medium text-gray-700 backdrop-blur transition hover:border-brand-600 hover:text-brand-600 xl:py-1.5"
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
              className={`block w-full shrink-0 ${HERO_SLIDE_HEIGHT}`}
              data-banner-full
              data-hero-slide
            >
              <BannerPicture
                src={banner.imageUrl}
                mobileSrc={banner.mobileImageUrl}
                alt={banner.altText ?? banner.headline}
                loading={i === 0 ? 'eager' : 'lazy'}
                // Phones: the 4:5 phone image, or the computer image whole. From 768px the slide's height, anchored right.
                className={`block w-full object-cover object-right ${banner.mobileImageUrl ? 'aspect-[4/5] sm:aspect-[8/3]' : 'aspect-[8/3]'} md:aspect-auto md:h-full`}
              />
            </Link>
          ) : (
          <div key={banner.id} className={`relative w-full shrink-0 ${HERO_SLIDE_HEIGHT}`} data-hero-slide>
            {banner.imageUrl ? (
              <>
                <div className="px-5 pt-5 sm:px-8 sm:pt-8 md:absolute md:inset-0 md:p-0">
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
                  className="pointer-events-none absolute inset-y-0 left-0 hidden w-4/5 bg-gradient-to-r from-cream-100/90 via-cream-100/60 to-transparent md:block lg:w-3/5 lg:from-cream-100/80 lg:via-cream-100/40"
                />
                <div className="relative p-5 sm:p-8 md:flex md:h-full md:max-w-[62%] md:flex-col md:justify-center md:py-6 md:pl-14 md:pr-0 lg:max-w-[50%] xl:max-w-[46%]" data-hero-copy>
                  <HeroCopy banner={banner} />
                </div>
              </>
            ) : (
              <div className="grid items-center gap-6 p-5 sm:p-8 md:h-full md:py-6 md:pl-14 lg:grid-cols-2 lg:gap-10" data-hero-copy>
                <div>
                  <HeroCopy banner={banner} />
                </div>
                <div className="hidden justify-end lg:flex">
                  {/* Until a banner image is uploaded in admin: designed, not blank. */}
                  <ArtPanel
                    icon={heroIcon(banner.primaryHref, i)}
                    caption={banner.highlight?.replace(/[.!]+$/, '')}
                    className="h-64 w-full max-w-lg shadow-lg xl:h-72"
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
            className="absolute left-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow transition hover:bg-white md:flex"
          >
            ‹
          </button>
          <button
            onClick={next}
            aria-label="Next slide"
            className="absolute right-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow transition hover:bg-white md:flex"
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
