import Link from 'next/link';
import { safeHref, type PromoTileView } from '@clowe/shared';
import BannerPicture from '@/components/BannerPicture';
import { TileMark } from '@/components/DesignedArt';

// The home page's promo tiles, shared with the admin preview so what admins
// see before saving is what shoppers get.

/**
 * One of the 4-tile row near the top of the home page. With a picture: the
 * picture whole on top (2:1), the words below it, nothing drawn over the
 * products. Without one: a designed tile, `index` alternating dark and light.
 * `label` is the linked category's name, shown above the title; without it
 * the title's first word is.
 */
export function PromoCard({ card, index, icon, label }: { card: PromoTileView; index: number; icon: string; label?: string }) {
  const eyebrow = label ?? card.title.split(' ')[0];
  const title = label ? card.title : card.title.split(' ').slice(1).join(' ') || card.title;
  if (card.imageMode === 'FULL_IMAGE' && card.imageUrl) {
    return (
      <Link href={safeHref(card.href) ?? '/products'} className="block overflow-hidden rounded-2xl" data-promo-full>
        <BannerPicture
          src={card.imageUrl}
          mobileSrc={card.mobileImageUrl}
          alt={card.altText ?? card.title}
          loading="lazy"
          className="block aspect-[4/3] w-full object-cover transition duration-300 hover:scale-[1.02]"
        />
      </Link>
    );
  }
  if (card.imageUrl) {
    return (
      <Link
        href={safeHref(card.href) ?? '/products'}
        className="group flex flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white text-ink-900 transition hover:shadow-md"
      >
        <span className="block overflow-hidden bg-cream-100">
          <BannerPicture
            src={card.imageUrl}
            mobileSrc={card.mobileImageUrl}
            alt=""
            loading="lazy"
            sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
            className="block aspect-[2/1] w-full object-cover object-right transition duration-300 group-hover:scale-[1.03]"
          />
        </span>
        <span className="flex flex-1 flex-col p-4">
          <span className="text-xs font-bold uppercase tracking-widest text-brand-600">{eyebrow}</span>
          <span className="mt-1 font-display text-lg font-bold leading-snug">{title}</span>
          {card.subtitle && <span className="mt-1 text-sm text-gray-600">{card.subtitle}</span>}
          <span className="mt-3 self-start rounded-lg border border-current px-3 py-1 text-xs font-bold uppercase tracking-wide">
            Shop Now
          </span>
        </span>
      </Link>
    );
  }
  const dark = index % 2 === 0;
  return (
    <Link
      href={safeHref(card.href) ?? '/products'}
      className={`group relative block overflow-hidden rounded-2xl ${dark ? 'bg-ink-950 text-white' : 'bg-cream-100 text-ink-900'}`}
    >
      <TileMark icon={icon} tone={dark ? 'dark' : 'light'} />
      <div className="relative p-5">
        <p className="text-xs font-bold uppercase tracking-widest opacity-70">{eyebrow}</p>
        <p className="mt-1 font-display text-lg font-bold leading-snug">{title}</p>
        {card.subtitle && (
          <p className={`mt-1 text-sm font-semibold ${dark ? 'text-brand-400' : 'text-brand-600'}`}>{card.subtitle}</p>
        )}
        <span className="mt-4 inline-block rounded-lg border border-current px-3 py-1 text-xs font-bold uppercase tracking-wide">
          Shop Now
        </span>
      </div>
    </Link>
  );
}

/** One of the three wide strips lower on the home page. */
export function PromoStrip({ strip, icon }: { strip: PromoTileView; icon: string }) {
  if (strip.imageMode === 'FULL_IMAGE' && strip.imageUrl) {
    return (
      <Link href={safeHref(strip.href) ?? '/products'} className="block overflow-hidden rounded-2xl" data-promo-full>
        <BannerPicture
          src={strip.imageUrl}
          mobileSrc={strip.mobileImageUrl}
          alt={strip.altText ?? strip.title}
          loading="lazy"
          className="block aspect-[8/3] w-full object-cover transition duration-300 hover:scale-[1.02]"
        />
      </Link>
    );
  }
  return (
    <Link href={safeHref(strip.href) ?? '/products'} className="group relative flex h-36 items-center overflow-hidden rounded-2xl bg-ink-950 text-white">
      {strip.imageUrl ? (
        <BannerPicture
          src={strip.imageUrl}
          mobileSrc={strip.mobileImageUrl}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover opacity-40 transition duration-300 group-hover:scale-105"
        />
      ) : (
        <TileMark icon={icon} />
      )}
      <div className="relative p-6">
        <p className="font-display text-lg font-bold uppercase tracking-wide">{strip.title}</p>
        {strip.subtitle && <p className="mt-0.5 text-sm font-semibold text-brand-400">{strip.subtitle}</p>}
        <span className="mt-3 inline-block rounded-lg border border-white/60 px-3 py-1 text-xs font-bold uppercase">
          Shop Now
        </span>
      </div>
    </Link>
  );
}
