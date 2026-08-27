'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CategoryCallout, CategoryBannerSlide } from '@clowe/shared';

interface Props {
  slides: CategoryBannerSlide[];
  /** Side-card bullets; the card is hidden when empty. */
  highlights: CategoryCallout[];
  /** Auto-advance interval in ms. */
  intervalMs?: number;
}

/**
 * Category hero: an auto-advancing banner carousel with arrows and dots, plus
 * the optional highlights card docked on the right.
 */
export default function CategoryHero({ slides, highlights, intervalMs = 6000 }: Props) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  // Clamp when the slide list changes underneath us.
  useEffect(() => {
    if (index >= slides.length) setIndex(0);
  }, [slides.length, index]);

  useEffect(() => {
    if (paused || slides.length < 2) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % slides.length), intervalMs);
    return () => clearInterval(timer);
  }, [paused, slides.length, intervalMs]);

  if (slides.length === 0) return null;
  const slide = slides[Math.min(index, slides.length - 1)];
  const go = (dir: 1 | -1) =>
    setIndex((i) => (i + dir + slides.length) % slides.length);

  return (
    <div
      className="relative overflow-hidden rounded-2xl bg-cream-100"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {slide.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={slide.id}
          src={slide.imageUrl}
          alt=""
          className="absolute inset-y-0 right-0 h-full w-3/4 object-cover"
        />
      )}

      <div className="relative flex min-h-[15rem] items-center gap-4 p-6 sm:min-h-[16rem] sm:p-8">
        {/* Copy — sits on a fade so it stays readable over the photo. */}
        <div className="max-w-sm bg-gradient-to-r from-cream-100 via-cream-100/90 to-transparent pr-8">
          {slide.eyebrow && (
            <p className="text-xs font-bold uppercase tracking-widest text-brand-600">
              {slide.eyebrow}
            </p>
          )}
          <p className="t-hero-luxury mt-2 text-ink-900">
            {slide.headline}
            {slide.highlight && (
              <>
                <br />
                <span className="text-brand-600">{slide.highlight}</span>
              </>
            )}
          </p>
          {slide.subtext && <p className="t-hero-desc mt-3 text-gray-600">{slide.subtext}</p>}
          <Link
            href={slide.primaryHref ?? '#products'}
            className="mt-5 inline-block rounded-lg bg-ink-900 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-ink-800"
          >
            {slide.primaryLabel}
          </Link>
        </div>

        {/* Highlights card */}
        {highlights.length > 0 && (
          <div className="ml-auto hidden w-56 shrink-0 space-y-3 rounded-2xl bg-white/95 p-4 shadow-lg backdrop-blur lg:block">
            {highlights.map((item) => (
              <div key={item.title} className="flex items-start gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-base">
                  {item.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink-900">{item.title}</p>
                  <p className="text-[11px] text-gray-500">{item.subtitle}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {slides.length > 1 && (
        <>
          <button
            onClick={() => go(-1)}
            aria-label="Previous slide"
            className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow-md transition hover:bg-white"
          >
            ‹
          </button>
          <button
            onClick={() => go(1)}
            aria-label="Next slide"
            className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow-md transition hover:bg-white"
          >
            ›
          </button>
          <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
            {slides.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setIndex(i)}
                aria-label={`Go to slide ${i + 1}`}
                aria-current={i === index}
                className={`h-1.5 rounded-full transition-all ${
                  i === index ? 'w-5 bg-brand-600' : 'w-1.5 bg-ink-900/25 hover:bg-ink-900/40'
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
