'use client';

import { useState } from 'react';
import {
  IMAGE_SLOTS,
  type CategoryBannerSlide,
  type HomeBannerView,
  type ImageSize,
  type PromoTileView,
} from '@clowe/shared';
import HeroCarousel from '@/components/home/HeroCarousel';
import CategoryHero from '@/components/category/CategoryHero';
import { PromoCard, PromoStrip } from '@/components/home/PromoTiles';

type Props =
  | { kind: 'HOME_HERO'; banner: HomeBannerView }
  | { kind: 'CATEGORY_BANNER'; slide: CategoryBannerSlide; icon?: string | null }
  | { kind: 'PROMO_CARD' | 'PROMO_STRIP'; tile: PromoTileView };

const ratio = (s: ImageSize) => `${s.width} / ${s.height}`;

/**
 * The banner as shoppers will see it, before it is saved. On a computer it is
 * the storefront's own component; the phone view mirrors the phone layout and
 * uses the phone image (the site can't be framed, so it isn't an iframe).
 * Links are inert here.
 */
export default function BannerPreview(props: Props) {
  const [view, setView] = useState<'computer' | 'phone'>('computer');

  const tab = (value: typeof view, label: string) => (
    <button
      type="button"
      onClick={() => setView(value)}
      aria-pressed={view === value}
      className={`rounded-full px-3 py-1 text-xs font-semibold ${
        view === value ? 'bg-ink-900 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="rounded-2xl border border-dashed border-brand-300 bg-cream-50 p-3" data-banner-preview>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-gray-600">Preview — not saved yet</p>
        <div className="flex gap-1.5">
          {tab('computer', '🖥 Computer')}
          {tab('phone', '📱 Phone')}
        </div>
      </div>
      {/* Links in the preview go nowhere. */}
      <div
        className="mt-3"
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest('a')) e.preventDefault();
        }}
      >
        {view === 'computer' ? <Computer {...props} /> : <Phone {...props} />}
      </div>
    </section>
  );
}

function Computer(props: Props) {
  switch (props.kind) {
    case 'HOME_HERO':
      return <HeroCarousel banners={[props.banner]} />;
    case 'CATEGORY_BANNER':
      return <CategoryHero icon={props.icon} slides={[props.slide]} highlights={[]} />;
    case 'PROMO_CARD':
      return (
        <div className="max-w-[300px]">
          <PromoCard card={props.tile} index={0} icon="🏷️" />
        </div>
      );
    case 'PROMO_STRIP':
      return (
        <div className="max-w-[420px]">
          <PromoStrip strip={props.tile} icon="🏷️" />
        </div>
      );
  }
}

/** A phone-width frame showing what a phone gets. */
function Phone(props: Props) {
  return (
    <div className="mx-auto w-[360px] max-w-full overflow-hidden rounded-[2rem] border-8 border-ink-900 bg-cream-50 p-3">
      <PhoneBody {...props} />
    </div>
  );
}

function PhoneBody(props: Props) {
  // The image a phone downloads: its own when there is one, else the computer one.
  const pick = (v: { imageUrl: string | null; mobileImageUrl: string | null }) => v.mobileImageUrl || v.imageUrl;

  if (props.kind === 'PROMO_CARD' || props.kind === 'PROMO_STRIP') {
    // The tiles' layout is the same at every width: the storefront's own, with the phone image.
    const tile = { ...props.tile, imageUrl: pick(props.tile), mobileImageUrl: null };
    return props.kind === 'PROMO_CARD' ? (
      <PromoCard card={tile} index={0} icon="🏷️" />
    ) : (
      <PromoStrip strip={tile} icon="🏷️" />
    );
  }

  // (TS can't narrow a member whose kind is itself a union: say it.)
  const v = props.kind === 'HOME_HERO' ? props.banner : (props as Extract<Props, { kind: 'CATEGORY_BANNER' }>).slide;
  const slot = props.kind === 'HOME_HERO' ? IMAGE_SLOTS.HOME_HERO : IMAGE_SLOTS.CATEGORY_BANNER;
  const image = pick(v);

  if (v.imageMode === 'FULL_IMAGE' && image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt={v.altText ?? v.headline}
        className="block w-full rounded-2xl object-cover"
        style={{ aspectRatio: ratio(v.mobileImageUrl ? slot.mobile : slot.full) }}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl bg-cream-100">
      {image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" className="block w-full object-cover" style={{ aspectRatio: ratio(slot.mobile) }} />
      )}
      <div className="p-5">
        {'eyebrow' in v && v.eyebrow && (
          <p className="text-xs font-bold uppercase tracking-widest text-brand-600">{v.eyebrow}</p>
        )}
        <p className="font-display text-2xl font-bold leading-tight text-ink-900">
          {v.headline}
          {v.highlight && props.kind === 'CATEGORY_BANNER' && (
            <>
              <br />
              <span className="text-brand-600">{v.highlight}</span>
            </>
          )}
        </p>
        {v.subtext && <p className="mt-2 text-sm text-gray-600">{v.subtext}</p>}
        <span className="mt-4 inline-block rounded-lg bg-ink-900 px-5 py-2.5 text-xs font-bold uppercase tracking-wide text-white">
          {v.primaryLabel}
        </span>
      </div>
    </div>
  );
}
