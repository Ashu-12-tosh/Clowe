'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CategoryCallout, CategoryBannerSlide } from '@clowe/shared';
import { safeHref, focalPosition } from '@clowe/shared';
import { ArtPanel } from '@/components/DesignedArt';
import BannerPicture from '@/components/BannerPicture';

interface Props {
  /** The category's glyph, for the art panel a slide without an image shows. */
  icon?: string | null;
  slides: CategoryBannerSlide[];
  /** Short callouts shown in a row under the banner; hidden when empty. */
  highlights: CategoryCallout[];
  /** Auto-advance interval in ms. */
  intervalMs?: number;
}

/**
 * A designed slide's picture. On a phone it sits above the words, whole (the
 * phone image's square, else the 16:9 picture), so no headline covers a
 * product and nothing is cut off; from 640px it fills the right three
 * quarters behind the words' fade, anchored right, where the products are.
 */
export function categoryPictureClass(mobileImageUrl: string | null | undefined): string {
  return `block w-full object-cover ${mobileImageUrl ? 'aspect-square' : 'aspect-video'} sm:absolute sm:inset-y-0 sm:right-0 sm:aspect-auto sm:h-full sm:w-3/4 sm:object-right`;
}

/** One slide, as it fills the carousel's shared cell. */
function Slide({ slide, icon, eager }: { slide: CategoryBannerSlide; icon?: string | null; eager: boolean }) {
  // The image is the slide: one link, nothing of ours drawn on it.
  if (slide.imageMode === 'FULL_IMAGE' && slide.imageUrl) {
    return (
      <Link href={safeHref(slide.primaryHref) ?? '#products'} className="block h-full" data-banner-full>
        <BannerPicture
          src={slide.imageUrl}
          mobileSrc={slide.mobileImageUrl}
          style={{ objectPosition: focalPosition(slide) }}
          alt={slide.altText ?? slide.headline}
          loading={eager ? 'eager' : 'lazy'}
          // A phone image is square; without one the computer image shows whole.
          className={`block h-full w-full object-cover ${slide.mobileImageUrl ? 'aspect-square sm:aspect-[10/3]' : 'aspect-[10/3]'}`}
        />
      </Link>
    );
  }
  return (
    <div className="relative h-full">
      {slide.imageUrl ? (
        <BannerPicture
          src={slide.imageUrl}
          mobileSrc={slide.mobileImageUrl}
          style={{ objectPosition: focalPosition(slide) }}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          className={categoryPictureClass(slide.mobileImageUrl)}
        />
      ) : (
        // Until a banner image is uploaded in admin: designed, not blank.
        <ArtPanel icon={icon ?? '🛍️'} className="absolute inset-y-3 right-3 hidden w-2/5 sm:flex" />
      )}
      {/* sm:pl-16 keeps the words clear of the previous-slide arrow. */}
      <div className={`relative flex h-full items-center p-6 sm:min-h-[16rem] sm:p-8 sm:pl-16 ${slide.imageUrl ? 'pb-9' : 'min-h-[15rem]'}`}>
        {/* Copy — on the plain side, on a fade so it stays readable. Headline (with its
            highlight) two lines at most, subtext two: every slide fits the same box. */}
        {/* Never wider than half the banner: the products sit in the right half. */}
        <div className="min-w-0 max-w-md bg-gradient-to-r from-cream-100 via-cream-100/90 to-transparent pr-8 sm:max-w-[min(32rem,50%)]">
          {slide.eyebrow && <p className="truncate text-xs font-bold uppercase tracking-widest text-brand-600">{slide.eyebrow}</p>}
          <p className="mt-2 line-clamp-2 font-display text-3xl font-bold leading-[1.1] text-ink-900 sm:text-4xl xl:text-5xl">
            {slide.headline}
            {slide.highlight && <span className="text-brand-600"> {slide.highlight}</span>}
          </p>
          {slide.subtext && <p className="t-hero-desc mt-3 line-clamp-2 text-gray-600">{slide.subtext}</p>}
          <Link
            href={safeHref(slide.primaryHref) ?? '#products'}
            className="mt-5 inline-block rounded-lg bg-ink-900 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-ink-800"
          >
            {slide.primaryLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Category hero: an auto-advancing banner carousel with arrows and dots. All
 * slides sit in one grid cell, so the banner keeps the height of its tallest
 * slide whichever is showing — the page never jumps on a change. The
 * highlights sit in a row under the banner, never over its picture.
 */
export default function CategoryHero({ icon, slides, highlights, intervalMs = 6000 }: Props) {
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
  const active = Math.min(index, slides.length - 1);
  const go = (dir: 1 | -1) => setIndex((i) => (i + dir + slides.length) % slides.length);

  return (
    <div>
      <div
        className="relative grid overflow-hidden rounded-2xl bg-cream-100"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        data-carousel
        aria-roledescription="carousel"
      >
        {slides.map((slide, i) => (
          <div
            key={slide.id}
            className={`[grid-area:1/1] transition-opacity duration-500 ${i === active ? 'z-[1] opacity-100' : 'pointer-events-none opacity-0'}`}
            aria-hidden={i !== active}
            inert={i !== active ? true : undefined}
          >
            <Slide slide={slide} icon={icon} eager={i === 0} />
          </div>
        ))}

        {slides.length > 1 && (
          <>
            <button
              onClick={() => go(-1)}
              aria-label="Previous slide"
              className="absolute left-3 top-1/2 z-[2] hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow-md transition hover:bg-white sm:flex"
            >
              ‹
            </button>
            <button
              onClick={() => go(1)}
              aria-label="Next slide"
              className="absolute right-3 top-1/2 z-[2] hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow-md transition hover:bg-white sm:flex"
            >
              ›
            </button>
            <div className="absolute inset-x-0 bottom-3 z-[2] flex justify-center gap-1.5">
              {slides.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => setIndex(i)}
                  aria-label={`Go to slide ${i + 1}`}
                  aria-current={i === active}
                  className={`h-1.5 rounded-full transition-all ${
                    i === active ? 'w-5 bg-brand-600' : 'w-1.5 bg-ink-900/25 hover:bg-ink-900/40'
                  }`}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Highlights: a row under the banner (never over its picture); phones skip it. */}
      {highlights.length > 0 && (
        <ul className="mt-3 hidden gap-3 sm:grid sm:grid-cols-3" data-category-highlights>
          {highlights.map((item) => (
            <li key={item.title} className="flex items-start gap-2.5 rounded-2xl border border-gray-100 bg-white p-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-base">{item.icon}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-ink-900">{item.title}</span>
                <span className="block truncate text-[11px] text-gray-500">{item.subtitle}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
