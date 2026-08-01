'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminSellerReferralRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

export default function AdminSellerReferralsPage() {
  const [rows, setRows] = useState<AdminSellerReferralRow[] | null>(null);
  const [error, setError] = useState('');
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    api<AdminSellerReferralRow[]>('/api/admin/seller-referrals', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  async function voidReferral(id: string) {
    setError('');
    try {
      await api(`/api/admin/seller-referrals/${id}/void`, {
        method: 'PATCH',
        body: { reason: reason.trim() },
        auth: true,
      });
      setVoiding(null);
      setReason('');
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Seller Referrals</h1>
      <p className="mt-1 text-sm text-gray-500">
        Who referred whom, sales progress toward the ₹15,000 target, and rewards paid. Void a
        referral if it looks fraudulent — voiding blocks any future reward.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {rows === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">No seller referrals yet.</p>
      )}

      {rows && rows.length > 0 && (
        <div className="mt-4 space-y-3">
          {rows.map((r) => {
            const pct = Math.min(100, Math.round((r.salesPaise / r.targetPaise) * 100));
            return (
              <div key={r.id} className="rounded-2xl border border-gray-100 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm">
                    <span className="font-semibold">{r.referrerShop}</span>
                    <span className="mx-2 text-gray-400">→</span>
                    <span className="font-semibold">{r.referredShop}</span>
                    {!r.referredApproved && (
                      <span className="ml-2 rounded-full bg-yellow-100 px-2 py-0.5 text-[11px] font-semibold text-yellow-700">
                        awaiting approval
                      </span>
                    )}
                  </p>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                      r.status === 'EARNED'
                        ? 'bg-green-100 text-green-700'
                        : r.status === 'VOID'
                          ? 'bg-gray-100 text-gray-500'
                          : 'bg-orange-100 text-orange-700'
                    }`}
                  >
                    {r.status}
                    {r.status === 'EARNED' ? ` · ${formatPaise(r.rewardPaise)}` : ''}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full ${r.status === 'EARNED' ? 'bg-green-500' : 'bg-brand-500'}`}
                    style={{ width: `${r.status === 'EARNED' ? 100 : pct}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {formatPaise(r.salesPaise)} / {formatPaise(r.targetPaise)} delivered sales · joined{' '}
                  {new Date(r.createdAt).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                  {r.earnedAt ? ` · earned ${new Date(r.earnedAt).toLocaleDateString('en-IN')}` : ''}
                </p>
                {r.voidReason && (
                  <p className="mt-1 text-xs text-gray-500">Voided: &ldquo;{r.voidReason}&rdquo;</p>
                )}

                {r.status !== 'VOID' && voiding !== r.id && (
                  <button
                    onClick={() => {
                      setVoiding(r.id);
                      setReason('');
                    }}
                    className="mt-3 rounded-lg border border-red-300 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50"
                  >
                    Void referral
                  </button>
                )}
                {voiding === r.id && (
                  <div className="mt-3 rounded-xl border border-red-200 bg-red-50/50 p-3">
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={300}
                      placeholder="Why is this referral being voided?"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
                      autoFocus
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void voidReferral(r.id)}
                        disabled={reason.trim().length < 5}
                        className="rounded-lg bg-red-600 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        Confirm void
                      </button>
                      <button
                        onClick={() => setVoiding(null)}
                        className="rounded-lg border border-gray-300 px-4 py-1.5 text-xs font-semibold text-gray-600 hover:bg-white"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
