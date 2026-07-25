'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthUser, SearchIntent } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';

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

/** Slim top bar: hamburger (mobile), search with AI voice, action icons. */
export default function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [listening, setListening] = useState(false);
  const [unread, setUnread] = useState(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Detect speech support only after mount — the server can't know the
  // browser's capabilities, and rendering the mic button server-side causes
  // a hydration mismatch.
  const [speechSupported, setSpeechSupported] = useState(false);
  useEffect(() => {
    setSpeechSupported(getSpeechRecognition() !== null);
  }, []);

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

  // Read login state on mount (and when the tab regains focus, e.g. after login).
  useEffect(() => {
    const load = () => {
      const stored = getStoredUser();
      setUser(stored);
      if (stored) {
        api<{ unreadCount: number }>('/api/notifications', { auth: true })
          .then((d) => setUnread(d.unreadCount))
          .catch(() => {});
      } else {
        setUnread(0);
      }
    };
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  return (
    <header className="sticky top-0 z-20 border-b border-gray-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        {/* Mobile: hamburger + logo */}
        <button
          onClick={onMenuClick}
          aria-label="Open menu"
          className="rounded-lg p-1.5 text-xl text-ink-900 hover:bg-cream-100 lg:hidden"
        >
          ☰
        </button>
        <Link href="/" className="lg:hidden">
          <span className="font-display text-lg font-bold uppercase tracking-[0.2em] text-brand-600">
            Clowe
          </span>
        </Link>

        {/* Search */}
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(q.trim() ? `/products?q=${encodeURIComponent(q.trim())}` : '/products');
          }}
        >
          <div className="relative mx-auto w-full max-w-xl">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-400">
              ⌕
            </span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={listening ? '🎙 Listening… speak now' : 'Search for products, brands and more…'}
              className="w-full rounded-full border border-gray-200 bg-cream-50 py-2 pl-9 pr-10 text-sm outline-none transition focus:border-brand-600 focus:bg-white"
            />
            {speechSupported && (
              <button
                type="button"
                onClick={startVoiceSearch}
                disabled={listening}
                aria-label="Voice search"
                title="Voice search (AI)"
                className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-base ${
                  listening ? 'animate-pulse text-red-500' : 'text-gray-400 hover:text-brand-600'
                }`}
              >
                🎙
              </button>
            )}
          </div>
        </form>

        {/* Action icons */}
        <nav className="flex items-center gap-1 text-lg text-ink-900 sm:gap-2">
          {user && (
            <Link
              href="/notifications"
              className="relative rounded-full p-2 hover:bg-cream-100"
              aria-label="Notifications"
            >
              🔔
              {unread > 0 && (
                <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </Link>
          )}
          <Link href="/wishlist" className="hidden rounded-full p-2 hover:bg-cream-100 sm:block" aria-label="Wishlist">
            ♡
          </Link>
          <Link href="/cart" className="rounded-full p-2 hover:bg-cream-100" aria-label="Cart">
            🛍
          </Link>
          {user ? (
            <Link
              href="/login"
              className="ml-1 rounded-full bg-ink-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-ink-800"
            >
              {user.name?.split(' ')[0] ?? 'Account'}
            </Link>
          ) : (
            <Link
              href="/login"
              className="ml-1 rounded-full bg-brand-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Login
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
