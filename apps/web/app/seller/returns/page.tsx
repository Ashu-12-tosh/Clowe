'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { RETURN_REASON_LABELS, type ReturnReasonValue, type SellerReturnRow } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const FILTERS = ['ALL', 'REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUNDED'] as const;

const returnStatusStyles: Record<string, string> = {
  REQUESTED: 'bg-orange-100 text-orange-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  REJECTED: 'bg-red-100 text-red-700',
  RECEIVED: 'bg-purple-100 text-purple-700',
  REFUNDED: 'bg-green-100 text-green-700',
};

export default function SellerReturnsPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [rows, setRows] = useState<SellerReturnRow[] | null>(null);

  useEffect(() => {
    const qs = filter === 'ALL' ? '' : `?status=${filter}`;
    api<SellerReturnRow[]>(`/api/seller/returns${qs}`, { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, [filter]);

  return (
    <div>
      <h1 className="text-2xl font-bold">Returns</h1>
      <p className="mt-1 text-sm text-gray-500">
        Review return requests, approve or decline them, and confirm items received back.
      </p>

      {/* Status filter chips */}
      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
              filter === f
                ? 'border-ink-900 bg-ink-900 text-white'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {rows === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No returns here. When a customer requests a return, it lands in this list.
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="mt-4 space-y-3">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/seller/returns/${r.id}`}
              className="flex gap-4 rounded-2xl border border-gray-100 bg-white p-4 transition hover:border-brand-600/40 hover:shadow-sm"
            >
              {r.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.imageUrl} alt="" className="h-16 w-14 shrink-0 rounded-lg object-cover" />
              ) : (
                <div className="h-16 w-14 shrink-0 rounded-lg bg-gray-100" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {r.orderNumber}
                    <span className="ml-2 font-normal text-gray-500">
                      {new Date(r.requestedAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                  </p>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${returnStatusStyles[r.status] ?? ''}`}
                  >
                    {r.status}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm">
                  {r.title}{' '}
                  <span className="text-gray-500">
                    · {r.color} / {r.size} · qty {r.quantity} · {formatPaise(r.pricePaise * r.quantity)}
                  </span>
                </p>
                <p className="mt-1 truncate text-xs text-gray-500">
                  {r.customerName} ·{' '}
                  <span className="font-medium text-ink-900">
                    {RETURN_REASON_LABELS[r.reason as ReturnReasonValue] ?? r.reason}
                  </span>
                  {r.details ? ` — ${r.details}` : ''}
                  {r.photos.length > 0 ? ` · 📷 ${r.photos.length}` : ''}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
