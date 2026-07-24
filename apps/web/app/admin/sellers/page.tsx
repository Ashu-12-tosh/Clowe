'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AdminSellerRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const TABS = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'ALL'] as const;

const statusStyles: Record<string, string> = {
  APPROVED: 'bg-green-100 text-green-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
  REJECTED: 'bg-red-100 text-red-700',
  SUSPENDED: 'bg-red-100 text-red-700',
};

function SellersInner() {
  const initialTab = useSearchParams().get('status') ?? 'PENDING';
  const [tab, setTab] = useState<string>(TABS.includes(initialTab as never) ? initialTab : 'PENDING');
  const [rows, setRows] = useState<AdminSellerRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setRows(null);
    const query = tab === 'ALL' ? '' : `?status=${tab}`;
    api<AdminSellerRow[]>(`/api/admin/sellers${query}`, { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, [tab]);
  useEffect(load, [load]);

  async function decide(id: string, action: 'approve' | 'reject' | 'suspend') {
    setError('');
    let reason: string | undefined;
    if (action !== 'approve') {
      reason = window.prompt(`Reason for ${action} (shown to the seller):`) ?? undefined;
      if (reason === undefined) return; // cancelled
    }
    try {
      await api(`/api/admin/sellers/${id}`, { method: 'PATCH', body: { action, reason }, auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Sellers</h1>

      <div className="mt-4 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${
              tab === t ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {rows === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && <p className="mt-6 text-sm text-gray-600">No sellers here.</p>}

      <div className="mt-4 space-y-3">
        {rows?.map((s) => (
          <div key={s.id} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">{s.shopName}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {s.userName ?? 'No name'} · +91 {s.phone} · {s.city ?? '—'}
                  {s.state ? `, ${s.state}` : ''} · {s.productCount} products · applied{' '}
                  {new Date(s.createdAt).toLocaleDateString('en-IN')}
                </p>
                {(s.gstNumber || s.panNumber) && (
                  <p className="mt-0.5 text-xs text-gray-500">
                    {s.gstNumber && <>GST: {s.gstNumber} </>}
                    {s.panNumber && <>PAN: {s.panNumber}</>}
                  </p>
                )}
                {s.rejectionReason && (
                  <p className="mt-0.5 text-xs text-red-600">Reason: {s.rejectionReason}</p>
                )}
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[s.status]}`}>
                {s.status}
              </span>
            </div>
            <div className="mt-3 flex gap-2">
              {s.status !== 'APPROVED' && (
                <button
                  onClick={() => void decide(s.id, 'approve')}
                  className="rounded-lg bg-green-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-green-700"
                >
                  Approve
                </button>
              )}
              {s.status === 'PENDING' && (
                <button
                  onClick={() => void decide(s.id, 'reject')}
                  className="rounded-lg border border-red-300 px-4 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                >
                  Reject
                </button>
              )}
              {s.status === 'APPROVED' && (
                <button
                  onClick={() => void decide(s.id, 'suspend')}
                  className="rounded-lg border border-red-300 px-4 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                >
                  Suspend
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminSellersPage() {
  return (
    <Suspense>
      <SellersInner />
    </Suspense>
  );
}
