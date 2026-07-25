'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SellerStats } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { useSeller } from '@/components/seller/SellerContext';

function StatusBanner() {
  const { state } = useSeller();
  if (state.kind !== 'ready') return null;
  const { status, rejectionReason } = state.profile;

  if (status === 'APPROVED') return null;

  const styles: Record<string, string> = {
    PENDING: 'border-yellow-200 bg-yellow-50 text-yellow-800',
    REJECTED: 'border-red-200 bg-red-50 text-red-700',
    SUSPENDED: 'border-red-200 bg-red-50 text-red-700',
  };
  const messages: Record<string, string> = {
    PENDING:
      'Your seller application is under review. You can add products once the admin approves your account.',
    REJECTED: `Your application was rejected${rejectionReason ? `: ${rejectionReason}` : '.'}`,
    SUSPENDED: 'Your seller account is suspended. Contact support.',
  };
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${styles[status]}`}>
      <span className="font-semibold">{status}</span> — {messages[status]}
    </div>
  );
}

export default function SellerDashboardPage() {
  const [stats, setStats] = useState<SellerStats | null>(null);

  useEffect(() => {
    api<SellerStats>('/api/seller/stats', { auth: true }).then(setStats).catch(() => {});
  }, []);

  const cards = stats
    ? [
        { label: 'Live products', value: String(stats.liveProducts) },
        { label: 'Pending approval', value: String(stats.pendingProducts) },
        { label: 'Units sold', value: String(stats.unitsSold) },
        { label: 'Revenue', value: formatPaise(stats.revenuePaise) },
      ]
    : [];

  return (
    <div>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <div className="mt-4">
        <StatusBanner />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{card.label}</p>
            <p className="mt-1 text-2xl font-bold text-brand-600">{card.value}</p>
          </div>
        ))}
        {!stats &&
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl bg-gray-200" />
          ))}
      </div>

      {stats && stats.lowStockVariants > 0 && (
        <p className="mt-4 text-sm text-orange-600">
          ⚠ {stats.lowStockVariants} variant{stats.lowStockVariants > 1 ? 's are' : ' is'} low on
          stock (&lt;5 left).
        </p>
      )}

      <div className="mt-8 flex gap-3">
        <Link
          href="/seller/products/new"
          className="rounded-lg bg-ink-900 px-6 py-2.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          + Add Product
        </Link>
        <Link
          href="/seller/orders"
          className="rounded-lg border-2 border-brand-600 px-6 py-2.5 text-sm font-bold uppercase tracking-wide text-brand-600 hover:bg-brand-50"
        >
          View Orders
        </Link>
      </div>
    </div>
  );
}
