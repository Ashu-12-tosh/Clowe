'use client';

import { useEffect, useState } from 'react';
import type { SellerReferralInfo } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/** Seller dashboard: referral code, share actions and "My referrals" progress. */
export default function ReferralCard() {
  const [info, setInfo] = useState<SellerReferralInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<SellerReferralInfo>('/api/seller/referral', { auth: true })
      .then(setInfo)
      .catch(() => {});
  }, []);

  if (!info) return null;

  const shareText = `Start selling on Clowe! 🛍 Register with my seller referral code ${info.code} — list your products, get AI Try-On for your catalogue, and grow your shop.`;
  const waLink = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(info!.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">Refer a seller, earn {formatPaise(info.rewardPaise)} 🤝</h2>
        {info.creditsEarnedPaise > 0 && (
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-700">
            Earned so far: {formatPaise(info.creditsEarnedPaise)}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Share your code. When a seller registers with it, gets approved, and crosses{' '}
        {formatPaise(info.targetPaise)} in delivered sales, you earn{' '}
        <span className="font-semibold text-ink-900">{formatPaise(info.rewardPaise)}</span> as Clowe
        Credits — one-time per referred seller.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-xl border-2 border-dashed border-brand-400 bg-brand-50 px-4 py-2 font-mono text-base font-bold tracking-widest text-brand-700">
          {info.code}
        </span>
        <button
          onClick={() => void copyCode()}
          className="rounded-lg border border-gray-300 px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-cream-100"
        >
          {copied ? '✓ Copied' : '⧉ Copy'}
        </button>
        <a
          href={waLink}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg bg-[#25D366] px-3.5 py-2 text-xs font-bold text-white hover:opacity-90"
        >
          Share on WhatsApp
        </a>
      </div>

      {info.referrals.length > 0 && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">My referrals</h3>
          <div className="mt-2 space-y-3">
            {info.referrals.map((r) => {
              const pct = Math.min(100, Math.round((r.salesPaise / info.targetPaise) * 100));
              return (
                <div key={r.id} className="text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <p className="font-semibold">
                      {r.shopName}
                      <span className="ml-2 text-xs font-normal text-gray-400">
                        joined{' '}
                        {new Date(r.joinedAt).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        r.status === 'EARNED'
                          ? 'bg-green-100 text-green-700'
                          : r.status === 'VOID'
                            ? 'bg-gray-100 text-gray-500'
                            : 'bg-orange-100 text-orange-700'
                      }`}
                    >
                      {r.status === 'EARNED' ? '✓ Earned' : r.status === 'VOID' ? 'Voided' : 'Pending'}
                    </span>
                  </div>
                  {!r.sellerApproved && (
                    <p className="mt-0.5 text-xs text-gray-400">Awaiting Clowe approval</p>
                  )}
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className={`h-full rounded-full ${r.status === 'EARNED' ? 'bg-green-500' : 'bg-brand-500'}`}
                      style={{ width: `${r.status === 'EARNED' ? 100 : pct}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    {formatPaise(r.salesPaise)} / {formatPaise(info.targetPaise)} delivered sales
                    {r.status === 'EARNED' && r.earnedAt
                      ? ` · reward earned ${new Date(r.earnedAt).toLocaleDateString('en-IN')}`
                      : ''}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
