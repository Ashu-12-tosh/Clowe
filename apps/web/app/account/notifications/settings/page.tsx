'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AuthUser } from '@clowe/shared';
import { api, getStoredUser, setStoredUser } from '@/lib/api';

type PrefKey = 'email' | 'sms' | 'whatsapp' | 'recommendations';

const ROWS: { key: PrefKey; icon: string; label: string; text: string }[] = [
  {
    key: 'email',
    icon: '📧',
    label: 'Email',
    text: 'Order updates, offers and newsletters by email',
  },
  { key: 'sms', icon: '✉️', label: 'SMS', text: 'Delivery and order alerts by text message' },
  {
    key: 'whatsapp',
    icon: '🟢',
    label: 'WhatsApp',
    text: 'Order confirmations and shipping updates on WhatsApp',
  },
  {
    key: 'recommendations',
    icon: '✨',
    label: 'Personalised recommendations',
    text: 'Use my browsing to suggest products I might like',
  },
];

export default function NotificationPreferencesPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [savedKey, setSavedKey] = useState<PrefKey | ''>('');
  const [error, setError] = useState('');

  useEffect(() => {
    setUser(getStoredUser());
    api<AuthUser>('/api/auth/me', { auth: true })
      .then((fresh) => {
        setStoredUser(fresh);
        setUser(fresh);
      })
      .catch(() => {});
  }, []);

  // Sessions cached before prefs existed default to everything on.
  const prefs = user?.prefs ?? { email: true, sms: true, whatsapp: true, recommendations: true };

  async function toggle(key: PrefKey) {
    setError('');
    try {
      const updated = await api<AuthUser>('/api/auth/me/preferences', {
        method: 'PATCH',
        body: { [key]: !prefs[key] },
        auth: true,
      });
      setStoredUser(updated);
      setUser(updated);
      setSavedKey(key);
      setTimeout(() => setSavedKey(''), 1500);
    } catch {
      setError('Could not save that preference');
    }
  }

  if (!user) return <div className="h-64 animate-pulse rounded-2xl bg-cream-100" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Notification Preferences</h1>
        <p className="mt-1 text-sm text-gray-500">
          Choose how we reach you. OTPs and order-critical messages are always sent.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white">
        {ROWS.map((row) => {
          const on = prefs[row.key];
          return (
            <li key={row.key} className="flex items-center gap-3 p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cream-100 text-lg">
                {row.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink-900">
                  {row.label}
                  {savedKey === row.key && (
                    <span className="ml-2 text-xs font-semibold text-green-600">✓ Saved</span>
                  )}
                </p>
                <p className="text-xs text-gray-500">{row.text}</p>
              </div>
              <button
                onClick={() => void toggle(row.key)}
                role="switch"
                aria-checked={on}
                aria-label={row.label}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                  on ? 'bg-brand-600' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    on ? 'left-[1.375rem]' : 'left-0.5'
                  }`}
                />
              </button>
            </li>
          );
        })}
      </ul>

      <Link href="/account/notifications" className="inline-block text-sm font-semibold text-brand-600 hover:underline">
        View my notifications →
      </Link>
    </div>
  );
}
