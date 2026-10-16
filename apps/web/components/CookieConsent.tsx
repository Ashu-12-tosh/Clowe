'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CONSENT_EVENT,
  OPEN_SETTINGS_EVENT,
  readConsent,
  saveConsent,
  type ConsentChoice,
} from '@/lib/cookieConsent';

const CATEGORIES: { key: keyof ConsentChoice; title: string; text: string }[] = [
  {
    key: 'functional',
    title: 'Functional',
    text: 'Remember your delivery PIN code, recently viewed products, recent searches and how you like to sign in.',
  },
  {
    key: 'analytics',
    title: 'Analytics and performance',
    text: 'Help us see which pages are used and where errors happen. We use no analytics provider at present.',
  },
  {
    key: 'advertising',
    title: 'Advertising and marketing',
    text: 'Measure campaigns and show relevant ads. We use no advertising provider at present.',
  },
];

/**
 * The cookie consent banner (Cookie Policy 4): on the first visit, and again
 * after 12 months. Strictly necessary cookies are always on; the others stay
 * off until accepted. "Cookie Settings" in the footer reopens the choices.
 */
export default function CookieConsent() {
  const [open, setOpen] = useState<'banner' | 'settings' | null>(null);
  const [choice, setChoice] = useState<ConsentChoice>({ functional: false, analytics: false, advertising: false });

  useEffect(() => {
    const saved = readConsent();
    if (saved) setChoice(saved);
    else setOpen('banner');
    const reopen = () => {
      setChoice(readConsent() ?? { functional: false, analytics: false, advertising: false });
      setOpen('settings');
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, reopen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, reopen);
  }, []);

  function decide(next: ConsentChoice) {
    saveConsent(next);
    setChoice(next);
    setOpen(null);
  }

  if (!open) return null;
  const all = { functional: true, analytics: true, advertising: true };
  const none = { functional: false, analytics: false, advertising: false };

  return (
    <div
      role="dialog"
      aria-label="Cookie settings"
      className="fixed inset-x-0 bottom-0 z-[60] p-3 sm:p-4"
      data-cookie-consent={open}
    >
      <div className="mx-auto max-w-3xl rounded-2xl border border-gray-200 bg-white p-4 shadow-2xl sm:p-5">
        <p className="text-sm font-bold text-ink-900">Cookies on Clowe</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-600">
          Strictly necessary cookies keep you signed in, hold your cart and protect your account — they are always on.
          Everything else is off until you choose.{' '}
          <Link href="/pages/cookie-policy" className="font-semibold text-brand-600 hover:underline">
            Cookie Policy
          </Link>
        </p>

        {open === 'settings' && (
          <ul className="mt-3 space-y-2">
            <li className="flex items-start justify-between gap-3 rounded-lg bg-cream-50 p-2.5">
              <span className="min-w-0">
                <span className="block text-xs font-bold text-ink-900">Strictly necessary</span>
                <span className="block text-[11px] text-gray-500">Sign-in, your session and cart, security. Always on.</span>
              </span>
              <input type="checkbox" checked disabled aria-label="Strictly necessary (always on)" className="mt-0.5 h-4 w-4" />
            </li>
            {CATEGORIES.map((c) => (
              <li key={c.key} className="flex items-start justify-between gap-3 rounded-lg bg-cream-50 p-2.5">
                <span className="min-w-0">
                  <span className="block text-xs font-bold text-ink-900">{c.title}</span>
                  <span className="block text-[11px] text-gray-500">{c.text}</span>
                </span>
                <input
                  type="checkbox"
                  name={c.key}
                  checked={choice[c.key]}
                  onChange={(e) => setChoice((prev) => ({ ...prev, [c.key]: e.target.checked }))}
                  aria-label={c.title}
                  className="mt-0.5 h-4 w-4 accent-brand-600"
                />
              </li>
            ))}
            <li className="text-[11px] text-gray-500">Third-party providers that set cookies: none at present.</li>
          </ul>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => decide(all)}
            className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
          >
            Accept all
          </button>
          <button
            onClick={() => decide(none)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-gray-700 hover:border-gray-400"
          >
            Only necessary
          </button>
          {open === 'banner' ? (
            <button
              onClick={() => setOpen('settings')}
              className="rounded-lg px-3 py-2 text-xs font-semibold text-brand-600 hover:underline"
            >
              Choose…
            </button>
          ) : (
            <button
              onClick={() => decide(choice)}
              className="rounded-lg border border-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-brand-600 hover:bg-brand-50"
            >
              Save my choices
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Re-render when consent changes (for components that read it). */
export function useConsentVersion(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((v) => v + 1);
    window.addEventListener(CONSENT_EVENT, bump);
    return () => window.removeEventListener(CONSENT_EVENT, bump);
  }, []);
  return n;
}
