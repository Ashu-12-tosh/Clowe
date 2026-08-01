'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
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

interface OrderGroup {
  orderNumber: string;
  placedAt: string;
  shipTo: SellerOrderItemRow['shipTo'];
  items: SellerOrderItemRow[];
}

/** One card per order — items of the same order grouped together. */
function groupByOrder(rows: SellerOrderItemRow[]): OrderGroup[] {
  const groups = new Map<string, OrderGroup>();
  for (const row of rows) {
    const existing = groups.get(row.orderNumber);
    if (existing) {
      existing.items.push(row);
    } else {
      groups.set(row.orderNumber, {
        orderNumber: row.orderNumber,
        placedAt: row.placedAt,
        shipTo: row.shipTo,
        items: [row],
      });
    }
  }
  return [...groups.values()];
}

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

  const groups = items ? groupByOrder(items) : null;

  return (
    <div>
      <h1 className="text-2xl font-bold">Orders</h1>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {groups === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}

      {groups && groups.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No orders yet. Orders will appear here once customers start buying.
        </p>
      )}

      {groups && groups.length > 0 && (
        <div className="mt-4 space-y-3">
          {groups.map((group) => {
            const orderTotal = group.items.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
            return (
              <div key={group.orderNumber} className="rounded-2xl border border-gray-100 bg-white p-4">
                {/* Order header */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-3">
                  <p className="text-sm font-semibold">
                    {group.orderNumber}
                    <span className="ml-2 font-normal text-gray-500">
                      {new Date(group.placedAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                  </p>
                  <p className="text-sm font-bold">
                    {group.items.length > 1 && (
                      <span className="mr-2 font-normal text-gray-500">
                        {group.items.length} items ·
                      </span>
                    )}
                    {formatPaise(orderTotal)}
                  </p>
                </div>

                {/* Items */}
                <div className="divide-y divide-gray-50">
                  {group.items.map((item) => (
                    <div key={item.id} className="py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 flex-1 text-sm">
                          {item.title}{' '}
                          <span className="text-gray-500">
                            · {item.color} / {item.size} · qty {item.quantity} ·{' '}
                            {formatPaise(item.pricePaise * item.quantity)}
                          </span>
                        </p>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[item.status] ?? ''}`}
                        >
                          {item.status.replace('_', ' ')}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
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
                        {item.returnId && (
                          <Link
                            href={`/seller/returns/${item.returnId}`}
                            className="rounded-lg border border-orange-300 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-orange-600 hover:bg-orange-50"
                          >
                            View return request →
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <p className="border-t border-gray-100 pt-2.5 text-xs text-gray-500">
                  Ship to: {group.shipTo.name}, {group.shipTo.city}, {group.shipTo.state} —{' '}
                  {group.shipTo.pincode}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
