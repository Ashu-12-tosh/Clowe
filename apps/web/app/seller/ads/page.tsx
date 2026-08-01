'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AD_PLACEMENT_LABELS, type SellerAdRow } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const adStatusStyles: Record<string, string> = {
  PENDING: 'bg-orange-100 text-orange-700',
  ACTIVE: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  EXPIRED: 'bg-gray-100 text-gray-600',
};

export default function SellerAdsPage() {
  const [ads, setAds] = useState<SellerAdRow[] | null>(null);

  useEffect(() => {
    api<SellerAdRow[]>('/api/seller/ads', { auth: true })
      .then(setAds)
      .catch(() => setAds([]));
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Advertise</h1>
          <p className="mt-1 text-sm text-gray-500">
            Promote your products in clearly-labeled Sponsored slots. Every ad is reviewed by Clowe.
          </p>
        </div>
        <Link
          href="/seller/ads/new"
          className="rounded-lg bg-ink-900 px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          + Create ad request
        </Link>
      </div>

      <p className="mt-3 rounded-lg border border-brand-100 bg-brand-50 px-4 py-2.5 text-xs text-brand-700">
        💳 Ad billing is manual for now — the amount is adjusted from your seller payouts once the ad
        is approved.
      </p>

      {ads === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {ads && ads.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No ads yet. Create your first ad request to appear in the home page banner or on top of
          your category.
        </p>
      )}

      {ads && ads.length > 0 && (
        <div className="mt-5 space-y-3">
          {ads.map((ad) => (
            <div key={ad.id} className="flex gap-4 rounded-2xl border border-gray-100 bg-white p-4">
              {ad.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={ad.imageUrl} alt="" className="h-20 w-16 shrink-0 rounded-lg object-cover" />
              ) : (
                <div className="h-20 w-16 shrink-0 rounded-lg bg-gray-100" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold">{ad.productTitle}</p>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${adStatusStyles[ad.status] ?? ''}`}>
                    {ad.status}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-gray-500">
                  {AD_PLACEMENT_LABELS[ad.placement]} · {ad.durationDays} days ·{' '}
                  <span className="font-semibold text-ink-900">{formatPaise(ad.pricePaise)}</span>
                </p>
                {ad.status === 'ACTIVE' && ad.endAt && (
                  <p className="mt-0.5 text-xs text-green-700">
                    Live until {new Date(ad.endAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </p>
                )}
                {ad.status === 'REJECTED' && ad.rejectionReason && (
                  <p className="mt-0.5 text-xs text-red-600">Declined: {ad.rejectionReason}</p>
                )}
                <p className="mt-1.5 text-xs text-gray-600">
                  👁 {ad.views} views · 🖱 {ad.clicks} clicks
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
