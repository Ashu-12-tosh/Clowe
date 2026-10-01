'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { AuthUser, MyCounts } from '@clowe/shared';
import { voiceSearchAvailable, voiceSearchErrorMessage } from '@clowe/shared';
import { api, getStoredUser, logoutSession } from '@/lib/api';
import CategoryNav from './CategoryNav';
import SearchBar from './search/SearchBar';

// Web Speech API (prefixed in Chrome/Safari).
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: { [i: number]: { [i: number]: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  /** The event carries the reason; without it every failure looks the same. */
  onerror: ((event: { error?: string }) => void) | null;
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

/**
 * Brave, by either signal it gives.
 *
 * navigator.brave.isBrave() is Brave's own API; the UA-CH brand is a second,
 * synchronous one. Either alone hides the mic, so losing one does not bring a
 * dead button back. The UA string is no use — Brave’s is byte-for-byte
 * Chrome's. If the call itself fails, the object being there at all is the
 * answer: no other browser has it.
 */
async function isBraveBrowser(): Promise<boolean> {
  const nav = navigator as Navigator & {
    brave?: { isBrave?: () => Promise<boolean> };
    userAgentData?: { brands?: { brand: string }[] };
  };
  if (nav.userAgentData?.brands?.some((b) => b.brand === 'Brave')) return true;
  try {
    return Boolean(await nav.brave?.isBrave?.());
  } catch {
    return Boolean(nav.brave);
  }
}

/**
 * How long to wait on a recogniser that has said nothing at all.
 *
 * Long enough for someone to gather their thoughts and speak, short enough
 * that a browser which is never going to answer does not hold the box on
 * "Listening…" while the shopper waits for something to happen.
 */
const VOICE_TIMEOUT_MS = 8000;

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
 * Site-wide chrome: main header (logo / search / actions with live counts)
 * and the category nav bar with its mega menu. The old top utility bar is
 * unmounted; see UtilityBar.tsx.
 */
export default function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [counts, setCounts] = useState<MyCounts>({ cart: 0, wishlist: 0, notifications: 0 });
  const [listening, setListening] = useState(false);
  // What went wrong last time the recogniser was asked, in words. Empty when
  // nothing has gone wrong or the shopper stopped it themselves.
  const [voiceError, setVoiceError] = useState('');
  // The best transcript seen so far. Interim results are on purely so a
  // failure part-way through still has something to search for.
  const heardRef = useRef('');
  // Phone-width search: the box is an icon until tapped, then a full-screen
  // overlay. Below md the inline box had ~14px to live in (logo and the action
  // icons are shrink-0, so the flexible search absorbed the whole shortfall).
  const [searchOpen, setSearchOpen] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Resolved after mount, for two reasons: rendering the mic server-side
  // causes a hydration mismatch, and the Brave check is a promise. Until it
  // resolves the mic is hidden, which is the safe direction.
  const [speechSupported, setSpeechSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const available = voiceSearchAvailable({
        hasRecognizer: getSpeechRecognition() !== null,
        isBrave: await isBraveBrowser(),
      });
      if (!cancelled) setSpeechSupported(available);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Publish the header's rendered height as --header-h. Anything that has to
  // stick just below the sticky header (the mobile filter bar on /products)
  // reads it, so it stays correct if the header's own height changes.
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty('--header-h', `${el.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--header-h');
    };
  }, []);

  /**
   * Speak a search, then run it exactly as if it had been typed.
   *
   * The transcript goes to /products?q=..., which parses it server-side with
   * parseSearchQuery — the same parser the typed box, the suggestions and the
   * results page already share. It reads price bounds, brands, sort and an
   * inferred category, so "black shoes under 2000" filters on price without
   * anyone here knowing what a rupee is.
   *
   * It deliberately does not call /api/ai/search-intent any more. That endpoint
   * ran a second, weaker parser of its own, and passed its category guess as a
   * hard filter — which the search work forbids, because a guessed category
   * removes products rather than ranking them.
   */
  function startVoiceSearch() {
    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor) {
      setVoiceError(voiceSearchErrorMessage('service-not-allowed'));
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognitionRef.current = recognition;
    recognition.lang = 'en-IN';
    // On so that a failure part-way through still leaves a transcript to fall
    // back to. Only the final result searches; see onend.
    recognition.interimResults = true;
    heardRef.current = '';
    setVoiceError('');
    setListening(true);

    const runSearch = (transcript: string) => {
      const spoken = transcript.trim();
      if (!spoken) return;
      setQ(spoken);
      router.push(`/products?q=${encodeURIComponent(spoken)}`);
    };

    /**
     * A recogniser is not obliged to answer.
     *
     * start() can be accepted, the microphone permission granted, and then no
     * result, no error and no end ever arrive — the box sits on "Listening…"
     * indefinitely, which is precisely what "it asks for the mic and then
     * nothing happens" looks like. Every callback below clears this; if none
     * of them runs, this is what ends it.
     */
    let settled = false;
    const finish = (code?: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      setListening(false);
      if (code) setVoiceError(voiceSearchErrorMessage(code));
      // Whatever was heard before it stopped is still worth searching for.
      runSearch(heardRef.current);
    };
    const watchdog = window.setTimeout(() => {
      try {
        recognition.stop();
      } catch {
        // Already dead; the point was to stop waiting on it, not to tidy it up.
      }
      finish('timeout');
    }, VOICE_TIMEOUT_MS);

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      if (transcript.trim()) heardRef.current = transcript;
      setQ(transcript);
    };
    recognition.onerror = (event) => {
      // Say which failure this was. Telling someone their browser cannot do
      // voice search because a packet dropped teaches them to stop trying.
      finish(event?.error ?? 'unknown');
    };
    recognition.onend = () => finish();
    recognition.start();
  }

  /**
   * Stop a run the shopper started, and search whatever was heard.
   *
   * stop() ends the recogniser, which fires onend, which is the same finish()
   * the watchdog and the error path call — so the transcript so far is still
   * searched and the listening state is cleared in one place. A recogniser that
   * ignores stop() as well is left to the watchdog.
   */
  function stopVoiceSearch() {
    try {
      recognitionRef.current?.stop();
    } catch {
      // Already finished. finish() has run or is about to; nothing to undo.
    }
  }

  // While the phone search overlay is up, hold the page behind it still —
  // otherwise a scroll gesture aimed at the suggestion list drags the
  // storefront underneath. Also drop the overlay if the viewport grows past
  // md (rotation), where it is display:none and its close button is too.
  useEffect(() => {
    if (!searchOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => mq.matches && setSearchOpen(false);
    mq.addEventListener('change', onChange);
    return () => {
      document.body.style.overflow = previousOverflow;
      mq.removeEventListener('change', onChange);
    };
  }, [searchOpen]);

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
    <header ref={headerRef} className="sticky top-0 z-30 bg-white shadow-sm">
      {/* The top utility bar (Download App / Become a Seller / shipping note /
          Help & Support) lives in ./UtilityBar.tsx and is intentionally not
          rendered. To bring it back: import UtilityBar and render <UtilityBar />
          here, then re-check the mobile filter-bar offset in app/products/page.tsx. */}

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

          {/* Search. The combobox owns its own dropdown, keyboard handling and
              request cancellation; voice search feeds it a transcript through
              the same input so spoken and typed queries are parsed alike. */}
          {/* md and up: the box sits inline and takes the free space — unchanged. */}
          <div className="hidden min-w-0 flex-1 items-center gap-2 md:flex">
            <SearchBar
              initialQuery={q}
              onVoiceSearch={startVoiceSearch}
              onVoiceStop={stopVoiceSearch}
              voiceActive={listening}
              voiceSupported={speechSupported}
              voiceError={voiceError}
            />
          </div>

          {/* Below md: an icon. ml-auto stands in for the flex-1 box that is
              hidden here, so the icon and the actions stay right-aligned. */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            aria-expanded={searchOpen}
            className="ml-auto rounded-lg p-1.5 text-xl leading-none text-ink-900 hover:bg-cream-100 md:hidden"
          >
            ⌕
          </button>

          {/* Actions — two states: guest vs logged in */}
          <nav className="flex shrink-0 items-center gap-0.5 text-ink-900 sm:gap-1">
            {user && (
              <Link
                href="/orders"
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

      {/* ---------------- Phone search overlay ----------------
          The same SearchBar the desktop header renders, given a full-width
          container instead of 14px. Reused rather than reimplemented: the
          debounce, request aborting, grouped dropdown, keyboard walking and
          ARIA wiring all live in that one component, and a second mobile-only
          search box would drift from it within a release or two.

          Only mounted while open, so the hidden desktop instance is the only
          other one alive and it is idle (it fetches on focus/typing). */}
      {searchOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search"
          // SearchBar's own Escape closes the dropdown and keeps what was
          // typed, calling preventDefault when it does. Honouring that flag is
          // what keeps Escape two-stage: dropdown first, overlay second.
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.defaultPrevented) setSearchOpen(false);
          }}
          className="fixed inset-0 z-50 bg-white md:hidden"
        >
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2.5">
            <button
              type="button"
              onClick={() => setSearchOpen(false)}
              aria-label="Close search"
              className="shrink-0 rounded-lg p-1.5 text-xl leading-none text-ink-900 hover:bg-cream-100"
            >
              ←
            </button>
            <SearchBar
              initialQuery={q}
              onVoiceSearch={startVoiceSearch}
              onVoiceStop={stopVoiceSearch}
              voiceActive={listening}
              voiceSupported={speechSupported}
              voiceError={voiceError}
              autoFocus
              onNavigate={() => setSearchOpen(false)}
            />
          </div>
        </div>
      )}
    </header>
  );
}
