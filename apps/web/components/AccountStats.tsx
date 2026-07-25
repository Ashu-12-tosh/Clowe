'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { OrderListRow, ReferralView, TryOnQuota, WishlistEntry } from '@clowe/shared';
import { api } from '@/lib/api';

/** Reference-style stat tiles — counts come from existing read-only APIs. */
export default function AccountStats() {
  const [orders, setOrders] = useState<number | null>(null);
  const [wishlist, setWishlist] = useState<number | null>(null);
  const [creditsPaise, setCreditsPaise] = useState<number | null>(null);
  const [tryOns, setTryOns] = useState<string | null>(null);

  useEffect(() => {
    api<OrderListRow[]>('/api/orders', { auth: true })
      .then((rows) => setOrders(rows.length))
      .catch(() => {});
    api<WishlistEntry[]>('/api/wishlist', { auth: true })
      .then((rows) => setWishlist(rows.length))
      .catch(() => {});
    api<ReferralView>('/api/referrals/me', { auth: true })
      .then((r) => setCreditsPaise(r.totalEarnedPaise))
      .catch(() => {});
    api<TryOnQuota>('/api/tryon/quota', { auth: true })
      .then((q) => setTryOns(`${q.usedToday}/${q.dailyLimit}`))
      .catch(() => {});
  }, []);

  const tiles = [
    { label: 'Orders', value: orders != null ? String(orders) : '—', href: '/orders' },
    { label: 'Wishlist', value: wishlist != null ? String(wishlist) : '—', href: '/wishlist' },
    {
      label: 'Clowe Credits',
      value: creditsPaise != null ? `₹${(creditsPaise / 100).toLocaleString('en-IN')}` : '—',
      href: '/referrals',
    },
    { label: 'Try-Ons Used', value: tryOns ?? '—', href: '/tryon' },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((tile) => (
        <Link
          key={tile.label}
          href={tile.href}
          className="rounded-2xl border border-gray-100 bg-white p-3 text-center transition hover:border-brand-600"
        >
          <p className="text-xl font-bold text-brand-600">{tile.value}</p>
          <p className="mt-0.5 text-xs text-gray-500">{tile.label}</p>
        </Link>
      ))}
    </div>
  );
}
