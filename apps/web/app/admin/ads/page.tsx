'use client';

import { useCallback, useEffect, useState } from 'react';
import { PLACEMENT_LABELS, type PlacementKind } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

// ---------------------------------------------------------------------------
// Advertising and sponsorship review (owner's Batch 2): creatives wait here
// before they run; a rejection frees the booked days and refunds the seller.
// Below, the calendar of every booked slot — advertising and sponsorship share
// it, so no space is ever sold twice.
// ---------------------------------------------------------------------------

const FILTERS = [
  ['PENDING_APPROVAL', 'Waiting'],
  ['ACTIVE', 'Running'],
  ['REJECTED', 'Rejected'],
  ['ENDED', 'Ended'],
] as const;

interface ReviewRow {
  id: string;
  name: string;
  sponsorship: boolean;
  placement: PlacementKind | null;
  status: string;
  shopName: string;
  product: { title: string; slug: string } | null;
  creativeUrl: string | null;
  headline: string | null;
  pricePaise: number;
  rejectionReason: string | null;
  days: string[];
  createdAt: string;
}
interface CalendarRow {
  day: string;
  space: string;
  scopeKey: string;
  slot: number;
  campaignId: string;
  name: string;
  status: string;
  sponsorship: boolean;
  placement: PlacementKind | null;
  shopName: string;
}

const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export default function AdminAdReviewPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('PENDING_APPROVAL');
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [calendar, setCalendar] = useState<CalendarRow[] | null>(null);
  const [from, setFrom] = useState(todayIst());
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<ReviewRow[]>(`/api/admin/ad-review?status=${filter}`, { auth: true }).then(setRows).catch(() => setRows([]));
  }, [filter]);
  const loadCalendar = useCallback(() => {
    api<CalendarRow[]>(`/api/admin/ad-review/calendar?from=${from}&days=31`, { auth: true }).then(setCalendar).catch(() => setCalendar([]));
  }, [from]);
  useEffect(load, [load]);
  useEffect(loadCalendar, [loadCalendar]);

  async function decide(id: string, action: 'approve' | 'reject') {
    setError('');
    try {
      await api(`/api/admin/ad-review/${id}`, { method: 'POST', body: action === 'reject' ? { action, reason } : { action }, auth: true });
      setRejecting(null);
      setReason('');
      load();
      loadCalendar();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Could not save — try again.');
    }
  }

  const spaces = [...new Set((calendar ?? []).map((c) => `${c.space}${c.scopeKey ? ` · ${c.scopeKey.slice(-6)}` : ''}`))];
  const days = [...new Set((calendar ?? []).map((c) => c.day))];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ads &amp; sponsorship review</h1>
        <p className="mt-1 text-sm text-gray-500">Approve creatives before they run. Rejecting frees the days and refunds the seller (with GST); the seller sees your reason.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === k ? 'bg-ink-900 text-white' : 'bg-gray-100 text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {rows === null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing here.</p>
      ) : (
        <ul className="space-y-3" data-ad-review>
          {rows.map((r) => (
            <li key={r.id} className="rounded-2xl border border-gray-100 bg-white p-4" data-review-row={r.id}>
              <div className="flex flex-wrap gap-4">
                {r.creativeUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.creativeUrl} alt="Creative" className="h-24 w-72 max-w-full rounded-lg border object-cover" />
                )}
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-semibold text-ink-900">
                    {r.placement ? PLACEMENT_LABELS[r.placement] : r.name}{' '}
                    <span className="text-xs font-normal text-gray-500">({r.sponsorship ? 'Sponsorship' : 'Advertising'})</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {r.shopName} · {formatPaise(r.pricePaise)} + GST · {r.days[0]}
                    {r.days.length > 1 ? ` → ${r.days[r.days.length - 1]} (${r.days.length} days)` : ''}
                  </p>
                  {r.headline && <p className="mt-1">“{r.headline}”</p>}
                  {r.product && <p className="text-xs text-gray-500">Product: {r.product.title}</p>}
                  {r.rejectionReason && <p className="text-xs text-red-600">Rejected: {r.rejectionReason}</p>}
                </div>
                {r.status === 'PENDING_APPROVAL' && (
                  <div className="flex flex-col gap-2">
                    <button type="button" onClick={() => decide(r.id, 'approve')} className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white">Approve</button>
                    <button type="button" onClick={() => setRejecting(rejecting === r.id ? null : r.id)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700">Reject…</button>
                  </div>
                )}
              </div>
              {rejecting === r.id && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why — the seller sees this" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm" name="reason" />
                  <button type="button" disabled={reason.trim().length < 3} onClick={() => decide(r.id, 'reject')} className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Reject and refund</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="rounded-2xl border border-gray-100 bg-white p-4" data-ad-calendar>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold">Booking calendar</h2>
          <label className="text-xs text-gray-500">
            From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-1 rounded border border-gray-200 px-2 py-1" />
          </label>
        </div>
        {calendar === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : calendar.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing booked in these 31 days.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white py-1 pr-2 text-left">Day</th>
                  {spaces.map((s) => <th key={s} className="px-2 py-1 text-left font-semibold">{s}</th>)}
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d} className="border-t border-gray-100 align-top">
                    <td className="sticky left-0 bg-white py-1 pr-2 font-medium">{d}</td>
                    {spaces.map((s) => (
                      <td key={s} className="px-2 py-1">
                        {(calendar ?? [])
                          .filter((c) => c.day === d && `${c.space}${c.scopeKey ? ` · ${c.scopeKey.slice(-6)}` : ''}` === s)
                          .map((c) => (
                            <span key={`${c.campaignId}-${c.slot}`} className={`mb-0.5 block rounded px-1 ${c.status === 'PENDING_APPROVAL' ? 'bg-orange-100' : c.sponsorship ? 'bg-purple-100' : 'bg-blue-100'}`} title={c.name}>
                              {c.shopName}
                            </span>
                          ))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-gray-500">Blue: advertising · purple: sponsorship · orange: waiting for approval.</p>
          </div>
        )}
      </section>
    </div>
  );
}
