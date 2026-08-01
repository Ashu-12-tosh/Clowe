'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CreditsInfo } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const LEDGER_LABELS: Record<string, string> = {
  EARN_PURCHASE: 'Earned on order',
  EARN_REFERRAL: 'Referral reward',
  REDEEM_CHECKOUT: 'Used at checkout',
  REFUND_CREDITS: 'Returned (order not completed)',
};

export default function CreditsPage() {
  const [credits, setCredits] = useState<CreditsInfo | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);

  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    api<CreditsInfo>('/api/credits', { auth: true })
      .then(setCredits)
      .catch(() => {});
  }, []);

  if (loggedOut) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Clowe Credits</p>
        <p className="mt-2 text-sm text-gray-600">
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Login
          </Link>{' '}
          to see your credits.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold">Clowe Credits 🪙</h1>
      <p className="mt-1 text-sm text-gray-600">
        Earn credits on every order and spend them as an instant discount on your next one.
      </p>

      {!credits && <p className="mt-6 text-sm text-gray-500">Loading…</p>}

      {credits && (
        <>
          {/* Balance card */}
          <div className="mt-5 rounded-2xl bg-ink-900 p-6 text-center text-white">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
              My balance
            </p>
            <p className="mt-2 font-display text-4xl font-bold">
              🪙 {credits.balance}
            </p>
            <p className="mt-1 text-lg font-semibold text-brand-400">
              = {formatPaise(credits.valuePaise)}
            </p>
          </div>

          {/* How it works */}
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-gray-100 bg-white p-4 text-center">
              <p className="text-2xl">🛍</p>
              <p className="mt-1 text-sm font-bold">Shop</p>
              <p className="mt-0.5 text-xs text-gray-500">
                Every ₹20 spent = 1 credit (₹200 → 10 credits)
              </p>
            </div>
            <div className="rounded-2xl border border-gray-100 bg-white p-4 text-center">
              <p className="text-2xl">🎁</p>
              <p className="mt-1 text-sm font-bold">Refer</p>
              <p className="mt-0.5 text-xs text-gray-500">
                Friend&apos;s first order = 100 credits.{' '}
                <Link href="/referrals" className="font-semibold text-brand-600 hover:underline">
                  Refer now →
                </Link>
              </p>
            </div>
            <div className="rounded-2xl border border-gray-100 bg-white p-4 text-center">
              <p className="text-2xl">💰</p>
              <p className="mt-1 text-sm font-bold">Save</p>
              <p className="mt-0.5 text-xs text-gray-500">
                10 credits = ₹5 off — tick &ldquo;Use my Clowe Credits&rdquo; at checkout
              </p>
            </div>
          </div>

          {/* History */}
          <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500">History</p>
            {credits.ledger.length === 0 ? (
              <p className="mt-2 text-sm text-gray-600">
                No credit activity yet — your first order starts earning.{' '}
                <Link href="/products" className="font-semibold text-brand-600 hover:underline">
                  Shop now →
                </Link>
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-gray-50 text-sm">
                {credits.ledger.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0 truncate text-gray-600">
                      {LEDGER_LABELS[row.reason] ?? row.reason}
                      {row.orderNumber ? ` · ${row.orderNumber}` : ''}
                      <span className="ml-1 text-xs text-gray-400">
                        {new Date(row.createdAt).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    </span>
                    <span className={`font-bold ${row.delta > 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {row.delta > 0 ? '+' : ''}
                      {row.delta} 🪙
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </main>
  );
}
