'use client';

import { useCallback, useEffect, useState } from 'react';
import { AD_PLACEMENT_LABELS, type AdminAdRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const FILTERS = ['PENDING', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ALL'] as const;

const adStatusStyles: Record<string, string> = {
  PENDING: 'bg-orange-100 text-orange-700',
  ACTIVE: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  EXPIRED: 'bg-gray-100 text-gray-600',
};

export default function AdminAdsPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('PENDING');
  const [rows, setRows] = useState<AdminAdRow[] | null>(null);
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    const qs = filter === 'ALL' ? '' : `?status=${filter}`;
    api<AdminAdRow[]>(`/api/admin/ads${qs}`, { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, [filter]);
  useEffect(load, [load]);

  async function decide(id: string, body: Record<string, string>) {
    setError('');
    try {
      await api(`/api/admin/ads/${id}`, { method: 'PATCH', body, auth: true });
      setRejecting(null);
      setReason('');
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Ads</h1>
      <p className="mt-1 text-sm text-gray-500">
        Review seller ad requests. Approved ads run for their duration in clearly-labeled Sponsored
        slots; the amount is collected manually / adjusted from payouts.
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
      {rows && rows.length === 0 && <p className="mt-6 text-sm text-gray-600">No ads in this view.</p>}

      {rows && rows.length > 0 && (
        <div className="mt-4 space-y-3">
          {rows.map((ad) => (
            <div key={ad.id} className="rounded-2xl border border-gray-100 bg-white p-4">
              <div className="flex gap-4">
                {ad.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ad.imageUrl} alt="" className="h-20 w-16 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="h-20 w-16 shrink-0 rounded-lg bg-gray-100" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">
                      {ad.productTitle}
                      <span className="ml-2 rounded bg-cream-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">
                        🏪 {ad.shopName}
                      </span>
                    </p>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${adStatusStyles[ad.status] ?? ''}`}>
                      {ad.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {AD_PLACEMENT_LABELS[ad.placement]} · {ad.durationDays} days ·{' '}
                    <span className="font-semibold text-ink-900">{formatPaise(ad.pricePaise)}</span> ·
                    requested{' '}
                    {new Date(ad.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </p>
                  {ad.status === 'ACTIVE' && ad.endAt && (
                    <p className="mt-0.5 text-xs text-green-700">
                      Live until {new Date(ad.endAt).toLocaleDateString('en-IN')} · 👁 {ad.views} · 🖱 {ad.clicks}
                    </p>
                  )}
                  {ad.status === 'REJECTED' && ad.rejectionReason && (
                    <p className="mt-0.5 text-xs text-red-600">Declined: {ad.rejectionReason}</p>
                  )}

                  {ad.status === 'PENDING' && rejecting !== ad.id && (
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => void decide(ad.id, { action: 'approve' })}
                        className="rounded-lg bg-ink-900 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
                      >
                        ✓ Approve — go live
                      </button>
                      <button
                        onClick={() => {
                          setRejecting(ad.id);
                          setReason('');
                        }}
                        className="rounded-lg border border-red-300 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50"
                      >
                        ✕ Reject
                      </button>
                    </div>
                  )}
                  {rejecting === ad.id && (
                    <div className="mt-3 rounded-xl border border-red-200 bg-red-50/50 p-3">
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={300}
                        placeholder="Reason shown to the seller"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
                        autoFocus
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => void decide(ad.id, { action: 'reject', reason: reason.trim() })}
                          disabled={reason.trim().length < 5}
                          className="rounded-lg bg-red-600 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          Confirm rejection
                        </button>
                        <button
                          onClick={() => setRejecting(null)}
                          className="rounded-lg border border-gray-300 px-4 py-1.5 text-xs font-semibold text-gray-600 hover:bg-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
