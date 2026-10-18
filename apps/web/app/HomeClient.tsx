'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { newsletterSubscribeSchema, type HomePayload, safeHref, imageAt } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import HeroCarousel from '@/components/home/HeroCarousel';
import { PromoCard, PromoStrip } from '@/components/home/PromoTiles';
import RecentlyViewed from '@/components/home/RecentlyViewed';
import { HomeAds } from '@/components/AdSlots';
import { CategoryGlyph } from '@/components/DesignedArt';
import {
  Countdown,
  DealCard,
  ProductHero,
  Scroller,
  SectionHeader,
  TrendingCard,
} from '@/components/home/HomeBits';
import PolicyText from '@/components/PolicyText';

const TRUST_ITEMS = [
  { icon: '🚚', title: 'Free Shipping', text: 'On all orders' },
  // Return Policy 2 and 3.1: defects, damage and wrong items, claimed within 48 hours.
  { icon: '↩️', title: 'Damage & Wrong-Item Protection', text: '48-hour claims, exchange or refund' },
  { icon: '🔒', title: 'Secure Payments', text: 'Safe & secure checkout' },
  { icon: '🤖', title: 'AI Shopping Assistant', text: 'Get smart help' },
  { icon: '🎧', title: 'Help & Support', text: 'Help centre and support chat' },
];

const AI_FEATURES = [
  { icon: '✨', title: 'AI Try-On', text: 'Try clothes on virtually', href: '/tryon' },
  { icon: '⌕', title: 'AI Search', text: 'Ask in your own words', href: '/ai-search' },
  { icon: '✦', title: 'AI Recommendations', text: 'Picks just for you', href: '/products' },
  { icon: '💬', title: 'AI Assistant', text: 'Your shopping buddy', href: '/pages/help' },
];

/**
 * The icon for a promo tile without a photo: the icon of the department its
 * link opens (a sub-category counts as its root's), else a tag.
 */
/** The top-level category a promo links into, if any. */
function promoCategory(href: string, categories: HomePayload['categories']) {
  let slug: string | null = null;
  try {
    slug = new URL(href, 'https://x.invalid').searchParams.get('category');
  } catch {
    // An unparsable link just gets the default.
  }
  return slug ? categories.find((c) => slug === c.slug || slug!.startsWith(`${c.slug}-`)) : undefined;
}

function promoIcon(href: string, categories: HomePayload['categories']): string {
  return promoCategory(href, categories)?.icon ?? '🏷️';
}

const BOTTOM_STRIP = [
  { icon: '🏷', title: 'Clear Pricing', text: 'GST included in every price' },
  { icon: '🗂', title: 'Many Departments', text: 'Fashion, electronics, home, beauty & more' },
  { icon: '🤝', title: 'Trusted Shopping', text: 'Secure payments & approved sellers' },
];

function NewsletterForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'dupe'>('idle');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const parsed = newsletterSubscribeSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setState('busy');
    try {
      const data = await api<{ alreadySubscribed: boolean }>('/api/home/newsletter', {
        body: parsed.data,
      });
      setState(data.alreadySubscribed ? 'dupe' : 'done');
      setEmail('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong — try again');
      setState('idle');
    }
  }

  if (state === 'done' || state === 'dupe') {
    return (
      <p className="flex items-center gap-2 text-sm font-semibold text-green-700">
        ✓ {state === 'done' ? "You're subscribed! Watch your inbox for deals." : "You're already on the list — thanks!"}
      </p>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="w-full max-w-md">
      <div className="flex overflow-hidden rounded-xl border border-gray-200 bg-white">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Enter your email address"
          className="min-w-0 flex-1 px-4 py-2.5 text-sm outline-none"
          aria-label="Email address"
        />
        <button
          disabled={state === 'busy'}
          className="bg-ink-900 px-5 text-sm font-bold text-white transition hover:bg-ink-800 disabled:opacity-60"
        >
          {state === 'busy' ? '…' : '→'}
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </form>
  );
}

/**
 * The home page. `initial` is the payload the server fetched with the page,
 * so the first paint already has the hero and rows in place (no loading
 * skeleton swapped for content, so nothing jumps). Without it — the login
 * backdrop — the page fetches for itself.
 */
export default function HomeClient({ initial = null }: { initial?: HomePayload | null }) {
  const [home, setHome] = useState<HomePayload | null>(initial);
  const [failed, setFailed] = useState(false);
  // The returns card quotes the platform window once settings arrive.

  const load = useCallback(() => {
    api<HomePayload>('/api/home')
      .then((payload) => {
        setHome(payload);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (!initial) load();
  }, [initial, load]);

  if (failed) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-20 text-center text-sm text-gray-500">
        Could not load the home page.{' '}
        <button onClick={load} className="font-semibold text-brand-600 hover:underline">
          Retry
        </button>
      </main>
    );
  }

  if (!home) {
    return (
      <main className="mx-auto max-w-7xl animate-pulse space-y-6 px-4 pt-4">
        <div className="h-80 rounded-3xl bg-cream-100" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 rounded-2xl bg-cream-100" />
          ))}
        </div>
        <div className="h-64 rounded-3xl bg-cream-100" />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4">
      {/* 1 ─ Hero carousel */}
      <div className="mt-4">
        {home.banners.length > 0 ? <HeroCarousel banners={home.banners} /> : <ProductHero products={home.trending} />}
      </div>

      {/* 2 ─ Trust strip */}
      {/* One per row on a phone. Two columns left ~72px for the label, which
          `truncate` then cut to "Free Shi…" — a trust strip that cannot be
          read is worse than one that costs a little scroll. */}
      <section className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TRUST_ITEMS.map((item) => (
          <div
            key={item.title}
            className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-3"
          >
            <span className="text-2xl">{item.icon}</span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-ink-900">{item.title}</p>
              <p className="text-xs text-gray-500">
                <PolicyText text={item.text} />
              </p>
            </div>
          </div>
        ))}
      </section>

      {/* 3 ─ Promo cards */}
      {home.promoCards.length > 0 && (
        <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {home.promoCards.map((card, i) => (
            <PromoCard
              key={card.id}
              card={card}
              index={i}
              icon={promoIcon(card.href, home.categories)}
              label={promoCategory(card.href, home.categories)?.name}
            />
          ))}
        </section>
      )}

      {/* 4 ─ Deals of the Day */}
      {home.deal && home.deal.products.length > 0 && (
        <section className="mt-10">
          <SectionHeader
            title={home.deal.title}
            accent={<Countdown endsAt={home.deal.endsAt} onExpire={load} />}
            href="/products"
          />
          <div className="mt-4">
            <Scroller>
              {home.deal.products.map((product) => (
                <DealCard key={product.id} product={product} />
              ))}
            </Scroller>
          </div>
        </section>
      )}

      {/* Paid placements, each labelled "Ad" or "Sponsored" */}
      <HomeAds />

      {/* 5 ─ Shop by Category */}
      <section className="mt-10">
        <SectionHeader title="Shop by Category" href="/products" />
        <div className="mt-4">
          <Scroller>
            {home.categories.map((cat) => (
              <Link
                key={cat.id}
                href={`/products?category=${cat.slug}`}
                className="group flex w-24 shrink-0 flex-col items-center gap-2"
              >
                <span className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl bg-cream-100 transition group-hover:bg-brand-100">
                  {cat.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imageAt(cat.imageUrl, 320)} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <CategoryGlyph icon={cat.icon} name={cat.name} />
                  )}
                </span>
                <span className="text-center text-xs font-medium text-gray-700 group-hover:text-brand-600">
                  {cat.name}
                </span>
              </Link>
            ))}
          </Scroller>
        </div>
      </section>

      {/* 6 ─ Experience AI Shopping */}
      <section className="mt-10 overflow-hidden rounded-3xl bg-ink-950 text-white">
        <div className="grid items-center gap-8 p-7 sm:p-10 lg:grid-cols-[1fr_auto]">
          <div>
            <h2 className="t-section">✨ Experience <span className="text-brand-400">AI Shopping</span></h2>
            <p className="t-section-desc mt-2 text-gray-400">Smart features that make shopping effortless.</p>
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {AI_FEATURES.map((feature) => (
                // eslint-disable-next-line no-restricted-syntax -- route from a table defined in code, not data
                <Link key={feature.title} href={feature.href} className="group">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-brand-600/40 bg-white/5 text-lg text-brand-400 transition group-hover:bg-brand-600 group-hover:text-white">
                    {feature.icon}
                  </span>
                  <p className="mt-2 text-sm font-bold">{feature.title}</p>
                  <p className="text-xs text-gray-400">{feature.text}</p>
                </Link>
              ))}
            </div>
          </div>
          <Link
            href="/tryon"
            className="group relative mx-auto hidden h-64 w-44 overflow-hidden rounded-[1.75rem] border-4 border-ink-700 bg-gradient-to-b from-ink-800 to-ink-950 shadow-2xl lg:block"
          >
            <div className="absolute inset-x-0 top-0 flex justify-center pt-2">
              <span className="h-1.5 w-14 rounded-full bg-ink-700" />
            </div>
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <span className="text-4xl">🪞</span>
              <p className="text-sm font-bold text-brand-400">AI Try-On</p>
              <p className="text-[11px] text-gray-400">See yourself in style</p>
              <span className="mt-2 rounded-full bg-brand-600 px-4 py-1.5 text-[11px] font-bold text-white transition group-hover:bg-brand-700">
                Try Now
              </span>
            </div>
          </Link>
        </div>
      </section>

      {/* 7 ─ Nothing to buy yet: say so, rather than leave a gap where the rails go */}
      {home.trending.length === 0 && !(home.deal && home.deal.products.length > 0) && (
        <section className="mt-10 grid items-center gap-6 overflow-hidden rounded-3xl border border-brand-100 bg-brand-50 p-7 sm:p-10 lg:grid-cols-[1fr_auto]">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-brand-600">Opening soon</p>
            <h2 className="t-section mt-2 text-ink-900">Sellers are setting up shop</h2>
            <p className="t-section-desc mt-2 max-w-xl text-gray-600">
              We are bringing verified sellers on board across fashion, electronics, home, beauty and
              books. Their first listings will appear here as they go live.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/sell"
                className="rounded-lg bg-ink-900 px-6 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
              >
                Sell on Clowe
              </Link>
              <a
                href="#newsletter"
                className="rounded-lg border border-brand-600 px-6 py-3 text-sm font-bold uppercase tracking-wide text-brand-600 hover:bg-brand-100"
              >
                Tell me when it opens
              </a>
            </div>
          </div>
          <div className="hidden grid-cols-3 gap-3 lg:grid" aria-hidden>
            {['👗', '📱', '🏠', '💄', '📚', '🎧'].map((icon) => (
              <span
                key={icon}
                className="flex h-20 w-20 items-center justify-center rounded-2xl border border-brand-100 bg-white text-3xl shadow-sm"
              >
                {icon}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 8 ─ Trending Now */}
      {home.trending.length > 0 && (
        <section className="mt-10">
          <SectionHeader title="Trending Now" href="/products" />
          {/* A grid, not a rail: every product in view without scrolling sideways. */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5" data-trending-grid>
            {home.trending.map((product) => (
              <TrendingCard key={product.id} product={product} fluid />
            ))}
          </div>
        </section>
      )}

      {/* 9 ─ Promo strips */}
      {home.promoStrips.length > 0 && (
        <section className="mt-10 grid gap-4 lg:grid-cols-3">
          {home.promoStrips.map((strip) => (
            <PromoStrip key={strip.id} strip={strip} icon={promoIcon(strip.href, home.categories)} />
          ))}
        </section>
      )}

      {/* 10 ─ Top Brands */}
      {home.brands.length > 0 && (
        <section className="mt-10">
          <SectionHeader title="Top Brands" href="/products" />
          <div className="mt-4">
            <Scroller>
              {home.brands.map((brand) => (
                <Link
                  key={brand.id}
                  href={`/products?q=${encodeURIComponent(brand.name)}`}
                  className="flex h-20 w-36 shrink-0 items-center justify-center rounded-2xl border border-gray-100 bg-white px-4 transition hover:-translate-y-0.5 hover:border-brand-600 hover:shadow-md"
                >
                  {brand.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imageAt(brand.logoUrl, 320)} alt={brand.name} loading="lazy" className="max-h-10 object-contain" />
                  ) : (
                    <span className="font-display text-base font-bold tracking-wide text-ink-900">
                      {brand.name}
                    </span>
                  )}
                </Link>
              ))}
            </Scroller>
          </div>
        </section>
      )}

      {/* 11 ─ Recently viewed (browser history; hides itself when empty) */}
      <RecentlyViewed />

      {/* 12 ─ Bottom strip + newsletter */}
      <section className="mb-4 mt-10 grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="grid gap-3 sm:grid-cols-3">
          {BOTTOM_STRIP.map((item) => (
            <div key={item.title} className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-3">
              <span className="text-2xl">{item.icon}</span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink-900">{item.title}</p>
                <p className="text-xs text-gray-500">{item.text}</p>
              </div>
            </div>
          ))}
        </div>
        <div id="newsletter" className="flex scroll-mt-24 flex-col justify-center rounded-2xl bg-cream-100 px-5 py-4 lg:w-96">
          <p className="text-sm font-bold text-ink-900">Stay Updated with CLOWE 🎁</p>
          <p className="mb-2.5 mt-0.5 text-xs text-gray-500">
            Get exclusive offers, latest deals &amp; more.
          </p>
          <NewsletterForm />
        </div>
      </section>
    </main>
  );
}
