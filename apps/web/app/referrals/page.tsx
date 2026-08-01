'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { REFERRAL_REWARD_CREDITS, type ReferralView } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';

export default function ReferralsPage() {
  const [data, setData] = useState<ReferralView | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    api<ReferralView>('/api/referrals/me', { auth: true })
      .then(setData)
      .catch(() => {});
  }, []);

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loggedOut) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Refer & Earn</p>
        <p className="mt-2 text-sm text-gray-600">
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Login
          </Link>{' '}
          to get your referral code.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold">Refer & Earn 🎁</h1>
      {data && (
        <p className="mt-1 text-sm text-gray-600">
          Earn{' '}
          <span className="font-semibold">🪙 {REFERRAL_REWARD_CREDITS} Clowe Credits</span> every
          time a friend signs up with your code and places their first order — spend them on your
          next purchase.{' '}
          <Link href="/credits" className="font-semibold text-brand-600 hover:underline">
            My credits →
          </Link>
        </p>
      )}

      {!data && !loggedOut && <p className="mt-6 text-sm text-gray-500">Loading…</p>}

      {data && (
        <>
          {/* Code card */}
          <div className="mt-5 rounded-2xl bg-gradient-to-r from-brand-600 to-brand-500 p-6 text-center text-white">
            <p className="text-xs font-semibold uppercase tracking-widest opacity-80">
              Your referral code
            </p>
            <p className="mt-2 font-mono text-3xl font-bold tracking-widest">{data.code}</p>
            <div className="mt-4 flex justify-center gap-2">
              <button
                onClick={() => void copy(data.code)}
                className="rounded-full bg-white/20 px-4 py-1.5 text-sm font-semibold hover:bg-white/30"
              >
                {copied ? '✓ Copied' : 'Copy code'}
              </button>
              <button
                onClick={() => void copy(data.shareText)}
                className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-brand-600 hover:bg-gray-100"
              >
                Copy share message
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-gray-200 bg-white p-3 text-center">
              <p className="text-xl font-bold">{formatPaise(data.totalEarnedPaise)}</p>
              <p className="text-xs text-gray-500">Earned</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-3 text-center">
              <p className="text-xl font-bold">{data.referrals.length}</p>
              <p className="text-xs text-gray-500">Friends joined</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-3 text-center">
              <p className="text-xl font-bold">{data.pendingCount}</p>
              <p className="text-xs text-gray-500">Pending first order</p>
            </div>
          </div>

          {/* List */}
          <h2 className="mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">
            Your referrals
          </h2>
          {data.referrals.length === 0 ? (
            <p className="mt-2 text-sm text-gray-600">
              No referrals yet. Share your code — your friends enter it when they sign up on the
              login page.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {data.referrals.map((r, i) => (
                <div key={i} className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-3">
                  <div>
                    <p className="text-sm font-semibold">{r.name}</p>
                    <p className="text-xs text-gray-500">
                      Joined {new Date(r.joinedAt).toLocaleDateString('en-IN')}
                    </p>
                  </div>
                  {r.status === 'CREDITED' ? (
                    <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                      +{formatPaise(r.rewardPaise)} credited
                    </span>
                  ) : (
                    <span className="rounded-full bg-yellow-100 px-3 py-1 text-xs font-semibold text-yellow-700">
                      Waiting for first order
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
