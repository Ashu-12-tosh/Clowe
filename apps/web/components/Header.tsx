'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { AuthUser, MyCounts, SearchIntent } from '@clowe/shared';
import { api, getStoredUser, logoutSession } from '@/lib/api';
import CategoryNav from './CategoryNav';

// Web Speech API (prefixed in Chrome/Safari).
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: { [i: number]: { [i: number]: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Other components dispatch this after cart/wishlist writes to refresh badges. */
export const BADGES_EVENT = 'clowe:refresh-badges';

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white">
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * Site-wide chrome: utility bar, main header (logo / search / actions with
 * live counts), and the category nav bar with its mega menu.
 */
export default function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [counts, setCounts] = useState<MyCounts>({ cart: 0, wishlist: 0, notifications: 0 });
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Detect speech support only after mount — rendering the mic server-side
  // causes a hydration mismatch.
  const [speechSupported, setSpeechSupported] = useState(false);
  useEffect(() => setSpeechSupported(getSpeechRecognition() !== null), []);

  // AI voice search: speech → transcript → /api/ai/search-intent → filtered shop page.
  function startVoiceSearch() {
    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor) return;
    const recognition = new SpeechRecognitionCtor();
    recognitionRef.current = recognition;
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    setListening(true);
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setQ(transcript);
      void api<SearchIntent>('/api/ai/search-intent', { body: { transcript } })
        .then((intent) => {
          const params = new URLSearchParams();
          if (intent.q) params.set('q', intent.q);
          if (intent.category) params.set('category', intent.category);
          if (intent.maxPrice) params.set('maxPrice', String(intent.maxPrice));
          if (intent.colors.length) params.set('colors', intent.colors.join(','));
          router.push(`/products?${params.toString()}`);
        })
        .catch(() => router.push(`/products?q=${encodeURIComponent(transcript)}`));
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognition.start();
  }

  // Login state + badge counts — refreshed on navigation, tab focus, and the
  // custom event dispatched after cart/wishlist writes.
  useEffect(() => {
    const load = () => {
      const stored = getStoredUser();
      setUser(stored);
      if (stored) {
        api<MyCounts>('/api/me/counts', { auth: true })
          .then(setCounts)
          .catch(() => {});
      } else {
        setCounts({ cart: 0, wishlist: 0, notifications: 0 });
      }
    };
    load();
    window.addEventListener('focus', load);
    window.addEventListener(BADGES_EVENT, load);
    return () => {
      window.removeEventListener('focus', load);
      window.removeEventListener(BADGES_EVENT, load);
    };
  }, [pathname]);

  return (
    <header className="sticky top-0 z-30 bg-white shadow-sm">
      {/* ---------------- Utility bar ---------------- */}
      <div className="bg-ink-950 text-[11px] text-gray-300 sm:text-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-1.5">
          <div className="hidden items-center gap-4 sm:flex">
            <Link href="/pages/app" className="hover:text-white">📱 Download App</Link>
            <Link href="/sell" className="hover:text-white">🏪 Become a Seller</Link>
          </div>
          <p className="t-announce mx-auto truncate text-center sm:absolute sm:left-1/2 sm:-translate-x-1/2">
            <span className="font-semibold text-brand-400">Free Shipping</span> on orders above ₹499
            <span className="mx-1.5 text-gray-500">|</span>7 Days Easy Returns
          </p>
          <Link href="/pages/help" className="hidden shrink-0 hover:text-white sm:block">
            🎧 Help &amp; Support
          </Link>
        </div>
      </div>

      {/* ---------------- Main header ---------------- */}
      <div className="border-b border-gray-100">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5 sm:gap-5">
          {/* Mobile hamburger */}
          <button
            onClick={onMenuClick}
            aria-label="Open menu"
            className="rounded-lg p-1.5 text-xl text-ink-900 hover:bg-cream-100 lg:hidden"
          >
            ☰
          </button>

          {/* Logo with crown + tagline */}
          <Link href="/" className="shrink-0 text-center leading-none">
            <span className="block text-[10px] leading-none text-brand-400">♛</span>
            <span className="t-logo-sm block uppercase text-ink-900">Clowe</span>
            <span className="t-tagline mt-0.5 hidden text-brand-600 sm:block">Shop Your Style</span>
          </Link>

          {/* Search — plain box: icon, input, clear, Search. Voice search sits
              beside it as its own AI button rather than crowding the bar. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <form
              className="min-w-0 flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                const query = q.trim();
                router.push(query ? `/products?q=${encodeURIComponent(query)}` : '/products');
              }}
            >
              <div className="mx-auto flex w-full max-w-2xl overflow-hidden rounded-xl border border-gray-200 bg-white focus-within:border-brand-600">
                <div className="relative min-w-0 flex-1">
                  <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                    ⌕
                  </span>
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={
                      listening ? '🎙 Listening… speak now' : 'Search for products, brands and more...'
                    }
                    aria-label="Search"
                    className="t-search w-full bg-transparent py-2.5 pl-9 pr-8 outline-none"
                  />
                  {q && (
                    <button
                      type="button"
                      onClick={() => setQ('')}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-base leading-none text-gray-400 transition hover:text-ink-900"
                    >
                      ×
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  className="t-btn shrink-0 bg-ink-900 px-5 text-white transition hover:bg-ink-800"
                >
                  Search
                </button>
              </div>
            </form>

            {speechSupported && (
              <button
                type="button"
                onClick={startVoiceSearch}
                disabled={listening}
                title="Search by voice (AI)"
                className={`hidden shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-bold transition lg:flex ${
                  listening
                    ? 'animate-pulse border-red-300 text-red-500'
                    : 'border-brand-200 text-brand-700 hover:border-brand-600 hover:bg-brand-50'
                }`}
              >
                🎙 AI Search
              </button>
            )}
          </div>

          {/* Actions — two states: guest vs logged in */}
          <nav className="flex shrink-0 items-center gap-0.5 text-ink-900 sm:gap-1">
            {user && (
              <Link
                href="/account/orders"
                className="hidden items-center gap-1.5 rounded-full px-2.5 py-2 text-sm hover:bg-cream-100 md:flex"
              >
                📦 <span className="hidden lg:inline">Orders</span>
              </Link>
            )}
            <Link
              href="/wishlist"
              aria-label="Wishlist"
              className="relative hidden items-center gap-1.5 rounded-full px-2.5 py-2 text-sm hover:bg-cream-100 sm:flex"
            >
              <span className="relative text-lg leading-none">
                ♡
                <Badge count={counts.wishlist} />
              </span>
              <span className="hidden lg:inline">Wishlist</span>
            </Link>
            <Link
              href="/cart"
              aria-label="Cart"
              className="relative flex items-center gap-1.5 rounded-full px-2.5 py-2 text-sm hover:bg-cream-100"
            >
              <span className="relative text-lg leading-none">
                🛍
                <Badge count={counts.cart} />
              </span>
              <span className="hidden lg:inline">Cart</span>
            </Link>

            {user ? (
              // Straight to the account dashboard — no dropdown in between.
              <Link
                href="/account"
                aria-label="My account"
                className="ml-1 flex items-center gap-2 rounded-full py-1 pl-1 pr-2 hover:bg-cream-100"
              >
                <span className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-cream-200 text-base">
                  {user.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    '👤'
                  )}
                  <Badge count={counts.notifications} />
                </span>
                <span className="hidden text-left leading-tight sm:block">
                  <span className="block max-w-28 truncate text-sm font-semibold">
                    Hi, {user.name?.split(' ')[0] ?? 'there'}
                  </span>
                  <span className="block text-[10px] font-semibold text-brand-600">My Account</span>
                </span>
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="ml-1 flex items-center gap-1.5 rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white hover:bg-ink-800"
                >
                  👤 Sign In
                </Link>
                <Link
                  href="/login?new=1"
                  className="hidden items-center gap-1.5 rounded-full border border-brand-600 px-4 py-2 text-sm font-semibold text-brand-600 hover:bg-brand-50 md:flex"
                >
                  👥 Create Account
                </Link>
              </>
            )}
          </nav>
        </div>
      </div>

      {/* ---------------- Category nav ---------------- */}
      <Suspense fallback={<div className="hidden h-10 border-b border-gray-100 lg:block" />}>
        <CategoryNav />
      </Suspense>
    </header>
  );
}
