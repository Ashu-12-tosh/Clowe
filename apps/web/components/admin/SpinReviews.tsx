'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import SpinViewer from '@/components/SpinViewer';

interface SpinReview {
  id: string;
  title: string;
  slug: string;
  shopName: string;
  live: string[];
  pending: string[];
  submittedAt: string | null;
}

/** 360° views waiting for review: approved, they go live; rejected, the seller is told why. */
export default function SpinReviews() {
  const [rows, setRows] = useState<SpinReview[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<SpinReview[]>('/api/admin/spin-reviews', { auth: true }).then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  async function decide(id: string, action: 'approve' | 'reject') {
    const reason = action === 'reject' ? prompt('Why is it not approved? (the seller sees this)') : undefined;
    if (action === 'reject' && (!reason || reason.trim().length < 3)) return;
    setError('');
    try {
      await api(`/api/admin/spin-reviews/${id}`, { auth: true, body: { action, ...(reason ? { reason: reason.trim() } : {}) }, success: action === 'approve' ? '360° view approved' : '360° view rejected' });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Not saved');
    }
  }

  if (rows.length === 0) return null;
  return (
    <section className="mt-4 rounded-2xl border border-amber-200 bg-white p-4" data-spin-reviews>
      <h2 className="text-sm font-bold text-ink-900">360° views to review ({rows.length})</h2>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl border border-gray-100 p-3 text-sm" data-spin-review={r.id}>
            <p className="font-semibold text-ink-900">{r.title}</p>
            <p className="text-xs text-gray-500">
              {r.shopName} · {r.pending.length} photos{r.live.length ? ' · replaces the live view' : ''}
            </p>
            <div className="mt-2 max-w-[220px]">
              <SpinViewer images={r.pending} alt={r.title} />
            </div>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => void decide(r.id, 'approve')} className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white">
                Approve
              </button>
              <button type="button" onClick={() => void decide(r.id, 'reject')} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700">
                Reject…
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
