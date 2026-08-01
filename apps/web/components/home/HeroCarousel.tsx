'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HomeBannerView } from '@clowe/shared';

const AI_PILLS = [
  { icon: '✦', label: 'AI Recommendations', href: '/products' },
  { icon: '⌕', label: 'AI Search', href: '/products' },
  { icon: '✨', label: 'AI Try-On', href: '/tryon' },
  { icon: '💬', label: 'AI Assistant', href: '/pages/help' },
];

const ROTATE_MS = 5500;

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
        {banners.map((banner, i) => (
          <div key={banner.id} className="w-full shrink-0">
            <div className="grid items-center gap-6 p-7 sm:p-10 lg:grid-cols-2 lg:gap-10">
              <div>
                <h1 className="font-display text-3xl font-bold leading-tight text-ink-900 sm:text-4xl lg:text-5xl">
                  <Headline text={banner.headline} highlight={banner.highlight} />
                </h1>
                {banner.subtext && (
                  <p className="mt-4 max-w-md text-sm leading-relaxed text-gray-600">
                    {banner.subtext}
                  </p>
                )}
                <div className="mt-6 flex flex-wrap gap-3">
                  <Link
                    href={banner.primaryHref}
                    className="rounded-lg bg-ink-900 px-6 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
                  >
                    {banner.primaryLabel}
                  </Link>
                  {banner.secondaryLabel && banner.secondaryHref && (
                    <Link
                      href={banner.secondaryHref}
                      className="rounded-lg border border-brand-600 px-6 py-3 text-sm font-bold uppercase tracking-wide text-brand-600 hover:bg-brand-50"
                    >
                      {banner.secondaryLabel}
                    </Link>
                  )}
                </div>
                <div className="mt-6 flex flex-wrap gap-2">
                  {AI_PILLS.map((pill) => (
                    <Link
                      key={pill.label}
                      href={pill.href}
                      className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-gray-700 backdrop-blur transition hover:border-brand-600 hover:text-brand-600"
                    >
                      <span className="text-brand-600">{pill.icon}</span>
                      {pill.label}
                    </Link>
                  ))}
                </div>
              </div>
              <div className="hidden justify-end lg:flex">
                {banner.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={banner.imageUrl}
                    alt=""
                    loading={i === 0 ? 'eager' : 'lazy'}
                    className="h-72 w-full max-w-lg rounded-2xl object-cover shadow-lg"
                  />
                )}
              </div>
            </div>
          </div>
        ))}
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
