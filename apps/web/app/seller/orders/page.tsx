'use client';

import { useEffect, useState } from 'react';
import type { SellerOrderItemRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
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

export default function SellerOrdersPage() {
  const [items, setItems] = useState<SellerOrderItemRow[] | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    api<SellerOrderItemRow[]>('/api/seller/orders', { auth: true })
      .then(setItems)
      .catch(() => setItems([]));
  };
  useEffect(load, []);

  async function updateStatus(itemId: string, action: 'ship' | 'deliver') {
    setError('');
    try {
      await api(`/api/seller/orders/${itemId}/status`, {
        method: 'PATCH',
        body: { action },
        auth: true,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Orders</h1>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {items === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}

      {items && items.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No orders yet. Orders will appear here once customers start buying (checkout arrives in
          Phase 5).
        </p>
      )}

      {items && items.length > 0 && (
        <div className="mt-4 space-y-3">
          {items.map((item) => (
            <div key={item.id} className="rounded-2xl border border-gray-100 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">
                  {item.orderNumber}
                  <span className="ml-2 font-normal text-gray-500">
                    {new Date(item.placedAt).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                </p>
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[item.status] ?? ''}`}
                >
                  {item.status}
                </span>
              </div>
              <p className="mt-2 text-sm">
                {item.title}{' '}
                <span className="text-gray-500">
                  · {item.color} / {item.size} · qty {item.quantity} ·{' '}
                  {formatPaise(item.pricePaise * item.quantity)}
                </span>
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Ship to: {item.shipTo.name}, {item.shipTo.city}, {item.shipTo.state} —{' '}
                {item.shipTo.pincode}
              </p>
              <div className="mt-3 flex gap-2">
                {(item.status === 'PLACED' || item.status === 'CONFIRMED') && (
                  <button
                    onClick={() => void updateStatus(item.id, 'ship')}
                    className="rounded-lg bg-ink-900 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
                  >
                    Mark shipped
                  </button>
                )}
                {item.status === 'SHIPPED' && (
                  <button
                    onClick={() => void updateStatus(item.id, 'deliver')}
                    className="rounded-lg bg-brand-600 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700"
                  >
                    Mark delivered
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
