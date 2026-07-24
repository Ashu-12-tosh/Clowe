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

/** Global site header: logo, search, nav, login/account. */
export default function Header() {
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
    <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
        <Link href="/" className="text-xl font-bold tracking-tight text-brand-900">
          Clowe
        </Link>

        <form
          className="hidden flex-1 sm:block"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(q.trim() ? `/products?q=${encodeURIComponent(q.trim())}` : '/products');
          }}
        >
          <div className="relative w-full max-w-md">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={listening ? '🎙 Listening… speak now' : 'Search for t-shirts, dresses, jeans…'}
              className="w-full rounded-full border border-gray-300 bg-gray-50 py-1.5 pl-4 pr-10 text-sm outline-none focus:border-brand-600"
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

        <nav className="ml-auto flex items-center gap-4 text-sm font-medium text-gray-700">
          <Link href="/products" className="hover:text-brand-600">
            Shop
          </Link>
          <Link href="/seller" className="hover:text-brand-600">
            Sell
          </Link>
          {user?.role === 'ADMIN' && (
            <Link href="/admin" className="font-semibold text-brand-600 hover:text-brand-700">
              Admin
            </Link>
          )}
          <Link href="/wishlist" className="hover:text-brand-600">
            ♡ Wishlist
          </Link>
          <Link href="/cart" className="hover:text-brand-600">
            🛒 Cart
          </Link>
          {user && (
            <Link href="/orders" className="hover:text-brand-600">
              Orders
            </Link>
          )}
          {user && (
            <Link href="/notifications" className="relative hover:text-brand-600" aria-label="Notifications">
              🔔
              {unread > 0 && (
                <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </Link>
          )}
          {user ? (
            <Link
              href="/login"
              className="rounded-full bg-brand-100 px-3 py-1 text-brand-600 hover:bg-brand-100/70"
            >
              {user.name?.split(' ')[0] ?? 'Account'}
            </Link>
          ) : (
            <Link
              href="/login"
              className="rounded-full bg-brand-600 px-4 py-1.5 text-white hover:bg-brand-700"
            >
              Login
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
