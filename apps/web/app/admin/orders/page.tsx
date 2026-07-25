'use client';

import { useEffect, useState } from 'react';
import type { AdminOrderRow } from '@clowe/shared';
import { api } from '@/lib/api';
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

export default function AdminOrdersPage() {
  const [rows, setRows] = useState<AdminOrderRow[] | null>(null);

  useEffect(() => {
    api<AdminOrderRow[]>('/api/admin/orders', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold">Orders</h1>

      {rows === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No orders yet — checkout arrives in Phase 5.
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-gray-100 bg-white">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3 text-right">Items</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 font-medium">{o.orderNumber}</td>
                  <td className="px-4 py-3">
                    {o.customerName ?? '—'}
                    <p className="text-xs text-gray-500">+91 {o.customerPhone}</p>
                  </td>
                  <td className="px-4 py-3 text-right">{o.itemCount}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatPaise(o.totalPaise)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[o.status] ?? ''}`}>
                      {o.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(o.createdAt).toLocaleDateString('en-IN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
