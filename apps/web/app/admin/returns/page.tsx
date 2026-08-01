'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { RETURN_REASON_LABELS, type AdminReturnRow, type ReturnReasonValue } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const FILTERS = ['ALL', 'REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUNDED'] as const;

const returnStatusStyles: Record<string, string> = {
  REQUESTED: 'bg-orange-100 text-orange-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  REJECTED: 'bg-red-100 text-red-700',
  RECEIVED: 'bg-purple-100 text-purple-700',
  REFUNDED: 'bg-green-100 text-green-700',
};

function AdminReturnsInner() {
  const initialStatus = useSearchParams().get('status');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(
    FILTERS.includes(initialStatus as (typeof FILTERS)[number]) ? (initialStatus as (typeof FILTERS)[number]) : 'ALL',
  );
  const [rows, setRows] = useState<AdminReturnRow[] | null>(null);
  const [error, setError] = useState('');
  const [overriding, setOverriding] = useState<string | null>(null); // return id with note box open
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    const qs = filter === 'ALL' ? '' : `?status=${filter}`;
    api<AdminReturnRow[]>(`/api/admin/returns${qs}`, { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, [filter]);
  useEffect(load, [load]);

  async function override(id: string) {
    setError('');
    try {
      await api(`/api/admin/returns/${id}/override`, {
        method: 'PATCH',
        body: { note: note.trim() || undefined },
        auth: true,
      });
      setOverriding(null);
      setNote('');
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Returns</h1>
      <p className="mt-1 text-sm text-gray-500">
        All returns across sellers. Rejected returns can be overridden (approved) for dispute resolution —
        overrides are logged and both sides are notified.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

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
      {rows && rows.length === 0 && <p className="mt-6 text-sm text-gray-600">No returns in this view.</p>}

      {rows && rows.length > 0 && (
        <div className="mt-4 space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-2xl border border-gray-100 bg-white p-4">
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
                  <span className="ml-2 rounded bg-cream-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">
                    🏪 {r.shopName}
                  </span>
                </p>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${returnStatusStyles[r.status] ?? ''}`}>
                  {r.status}
                </span>
              </div>

              <div className="mt-2 flex gap-3">
                {r.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.imageUrl} alt="" className="h-14 w-12 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="h-14 w-12 shrink-0 rounded-lg bg-gray-100" />
                )}
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate">
                    {r.title}{' '}
                    <span className="text-gray-500">
                      · {r.color} / {r.size} · qty {r.quantity} · {formatPaise(r.pricePaise * r.quantity)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {r.customerName} (+91 {r.customerPhone}) ·{' '}
                    <span className="font-medium text-ink-900">
                      {RETURN_REASON_LABELS[r.reason as ReturnReasonValue] ?? r.reason}
                    </span>
                    {r.details ? ` — “${r.details}”` : ''}
                  </p>
                  {r.photos.length > 0 && (
                    <div className="mt-1.5 flex gap-1.5">
                      {r.photos.map((url) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt="Return photo" className="h-12 w-12 rounded object-cover hover:opacity-80" />
                        </a>
                      ))}
                    </div>
                  )}
                  {r.rejectionReason && (
                    <p className="mt-1.5 text-xs text-red-600">Seller declined: &ldquo;{r.rejectionReason}&rdquo;</p>
                  )}
                  {r.adminOverrideAt && (
                    <p className="mt-1 text-xs font-medium text-brand-700">
                      ⚖️ Overridden by admin on {new Date(r.adminOverrideAt).toLocaleDateString('en-IN')}
                    </p>
                  )}
                  {r.refund && (
                    <p className="mt-1 text-xs text-gray-600">
                      Refund: {formatPaise(r.refund.amountPaise)} ·{' '}
                      <span className={r.refund.status === 'PROCESSED' ? 'font-semibold text-green-700' : 'font-semibold text-orange-600'}>
                        {r.refund.status}
                      </span>
                      {r.refund.providerRefundId && (
                        <span className="ml-1 font-mono text-gray-400">{r.refund.providerRefundId}</span>
                      )}
                    </p>
                  )}
                </div>
              </div>

              {r.status === 'REJECTED' && overriding !== r.id && (
                <button
                  onClick={() => {
                    setOverriding(r.id);
                    setNote('');
                  }}
                  className="mt-3 rounded-lg border border-brand-600 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-brand-700 hover:bg-brand-50"
                >
                  ⚖️ Override — approve this return
                </button>
              )}
              {overriding === r.id && (
                <div className="mt-3 rounded-xl border border-brand-100 bg-brand-50/50 p-3">
                  <p className="text-xs font-semibold text-ink-900">
                    Approve this return against the seller&apos;s decision?
                  </p>
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={300}
                    placeholder="Note for the seller (optional)"
                    className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => void override(r.id)}
                      className="rounded-lg bg-ink-900 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
                    >
                      Confirm override
                    </button>
                    <button
                      onClick={() => setOverriding(null)}
                      className="rounded-lg border border-gray-300 px-4 py-1.5 text-xs font-semibold text-gray-600 hover:bg-white"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminReturnsPage() {
  return (
    <Suspense>
      <AdminReturnsInner />
    </Suspense>
  );
}
