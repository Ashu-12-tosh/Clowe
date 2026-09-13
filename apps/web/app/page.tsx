'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { newsletterSubscribeSchema, type HomePayload } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import HeroCarousel from '@/components/home/HeroCarousel';
import RecentlyViewed from '@/components/home/RecentlyViewed';
import {
  Countdown,
  DealCard,
  Scroller,
  SectionHeader,
  TrendingCard,
} from '@/components/home/HomeBits';

const TRUST_ITEMS = [
  { icon: '🚚', title: 'Free Shipping', text: 'On orders above ₹499' },
  { icon: '↩️', title: 'Easy Returns', text: '7 days easy returns' },
  { icon: '🔒', title: 'Secure Payments', text: '100% protected' },
  { icon: '🤖', title: 'AI Shopping Assistant', text: 'Get smart help' },
  { icon: '🎧', title: '24x7 Support', text: "We're here for you" },
];

const AI_FEATURES = [
  { icon: '✨', title: 'AI Try-On', text: 'Try clothes on virtually', href: '/tryon' },
  { icon: '⌕', title: 'AI Search', text: 'Search with voice', href: '/products' },
  { icon: '✦', title: 'AI Recommendations', text: 'Picks just for you', href: '/products' },
  { icon: '💬', title: 'AI Assistant', text: 'Your shopping buddy', href: '/pages/help' },
];

const BOTTOM_STRIP = [
  { icon: '🏷', title: 'Best Prices', text: 'We offer competitive prices' },
  { icon: '🗂', title: 'Wide Assortment', text: 'Thousands of products in one place' },
  { icon: '🤝', title: 'Trusted Shopping', text: 'Secure payments & easy returns' },
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

export default function HomePage() {
  const [home, setHome] = useState<HomePayload | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api<HomePayload>('/api/home')
      .then((payload) => {
        setHome(payload);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

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
        <HeroCarousel banners={home.banners} />
      </div>

      {/* 2 ─ Trust strip */}
      <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TRUST_ITEMS.map((item) => (
          <div
            key={item.title}
            className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-3"
          >
            <span className="text-2xl">{item.icon}</span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-ink-900">{item.title}</p>
              <p className="truncate text-xs text-gray-500">{item.text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* 3 ─ Promo cards */}
      {home.promoCards.length > 0 && (
        <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {home.promoCards.map((card, i) => (
            <Link
              key={card.id}
              href={card.href}
              className={`group relative overflow-hidden rounded-2xl ${i % 2 === 0 ? 'bg-ink-950 text-white' : 'bg-cream-100 text-ink-900'}`}
            >
              {card.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={card.imageUrl}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover opacity-30 transition duration-300 group-hover:scale-105 group-hover:opacity-40"
                />
              )}
              <div className="relative p-5">
                <p className="text-xs font-bold uppercase tracking-widest opacity-70">
                  {card.title.split(' ')[0]}
                </p>
                <p className="mt-1 font-display text-lg font-bold leading-snug">
                  {card.title.split(' ').slice(1).join(' ') || card.title}
                </p>
                {card.subtitle && (
                  <p className={`mt-1 text-sm font-semibold ${i % 2 === 0 ? 'text-brand-400' : 'text-brand-600'}`}>
                    {card.subtitle}
                  </p>
                )}
                <span className="mt-4 inline-block rounded-lg border border-current px-3 py-1 text-xs font-bold uppercase tracking-wide">
                  Shop Now
                </span>
              </div>
            </Link>
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
                    <img src={cat.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-3xl">{cat.icon ?? '🛍'}</span>
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

      {/* 7 ─ Trending Now */}
      {home.trending.length > 0 && (
        <section className="mt-10">
          <SectionHeader title="Trending Now" href="/products" />
          <div className="mt-4">
            <Scroller>
              {home.trending.map((product) => (
                <TrendingCard key={product.id} product={product} />
              ))}
            </Scroller>
          </div>
        </section>
      )}

      {/* 8 ─ Promo strips */}
      {home.promoStrips.length > 0 && (
        <section className="mt-10 grid gap-4 lg:grid-cols-3">
          {home.promoStrips.map((strip) => (
            <Link
              key={strip.id}
              href={strip.href}
              className="group relative flex h-36 items-center overflow-hidden rounded-2xl bg-ink-950 text-white"
            >
              {strip.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={strip.imageUrl}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover opacity-40 transition duration-300 group-hover:scale-105"
                />
              )}
              <div className="relative p-6">
                <p className="font-display text-lg font-bold uppercase tracking-wide">{strip.title}</p>
                {strip.subtitle && (
                  <p className="mt-0.5 text-sm font-semibold text-brand-400">{strip.subtitle}</p>
                )}
                <span className="mt-3 inline-block rounded-lg border border-white/60 px-3 py-1 text-xs font-bold uppercase">
                  Shop Now
                </span>
              </div>
            </Link>
          ))}
        </section>
      )}

      {/* 9 ─ Top Brands */}
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
                    <img src={brand.logoUrl} alt={brand.name} loading="lazy" className="max-h-10 object-contain" />
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

      {/* 10 ─ Recently viewed (browser history; hides itself when empty) */}
      <RecentlyViewed />

      {/* 11 ─ Bottom strip + newsletter */}
      <section className="mb-4 mt-10 grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="grid gap-3 sm:grid-cols-3">
          {BOTTOM_STRIP.map((item) => (
            <div key={item.title} className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-3">
              <span className="text-2xl">{item.icon}</span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink-900">{item.title}</p>
                <p className="truncate text-xs text-gray-500">{item.text}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col justify-center rounded-2xl bg-cream-100 px-5 py-4 lg:w-96">
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
