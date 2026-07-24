'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { OrderListRow } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const statusStyles: Record<string, string> = {
  PLACED: 'bg-blue-100 text-blue-700',
  CONFIRMED: 'bg-blue-100 text-blue-700',
  SHIPPED: 'bg-purple-100 text-purple-700',
  DELIVERED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-100 text-orange-700',
  RETURNED: 'bg-red-100 text-red-700',
};

export default function OrdersPage() {
  const [rows, setRows] = useState<OrderListRow[] | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);

  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    api<OrderListRow[]>('/api/orders', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  if (loggedOut) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">My Orders</p>
        <p className="mt-2 text-sm text-gray-600">
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Login
          </Link>{' '}
          to see your orders.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-bold">My Orders</h1>

      {rows === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No orders yet.{' '}
          <Link href="/products" className="font-semibold text-brand-600 hover:underline">
            Start shopping →
          </Link>
        </p>
      )}

      <div className="mt-4 space-y-3">
        {rows?.map((o) => (
          <Link
            key={o.id}
            href={`/orders/${o.id}`}
            className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-3 transition hover:shadow-md"
          >
            {o.previewImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={o.previewImageUrl} alt="" className="h-16 w-12 rounded-lg object-cover" />
            ) : (
              <div className="h-16 w-12 rounded-lg bg-gray-100" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{o.orderNumber}</p>
              <p className="mt-0.5 text-xs text-gray-500">
                {o.itemCount} item{o.itemCount > 1 ? 's' : ''} ·{' '}
                {new Date(o.createdAt).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </p>
            </div>
            <div className="text-right">
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[o.status] ?? ''}`}>
                {o.status.replace('_', ' ')}
              </span>
              <p className="mt-1 text-sm font-bold">{formatPaise(o.totalPaise)}</p>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
