'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { AdminComplaintRow, ComplaintStatusValue } from '@clowe/shared';
import { COMPLAINT_CATEGORIES, COMPLAINT_CATEGORY_LABELS, COMPLAINT_STATUSES } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const STATUS_TABS = ['ALL', ...COMPLAINT_STATUSES] as const;

const STATUS_STYLES: Record<string, string> = {
  OPEN: 'bg-yellow-100 text-yellow-700',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  RESOLVED: 'bg-green-100 text-green-700',
  CLOSED: 'bg-gray-100 text-gray-600',
};

/** Expanded detail: full description, user/order info, status + notes editor. */
function ComplaintDetail({
  complaint,
  onUpdated,
}: {
  complaint: AdminComplaintRow;
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState<ComplaintStatusValue>(complaint.status);
  const [notes, setNotes] = useState(complaint.adminNotes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function save() {
    setError('');
    setBusy(true);
    try {
      await api(`/api/admin/complaints/${complaint.id}`, {
        method: 'PATCH',
        body: { status, adminNotes: notes.trim() || undefined },
        auth: true,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">Full description</h3>
        <p className="mt-1 whitespace-pre-line rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
          {complaint.description}
        </p>
      </div>

      <p className="text-xs text-gray-500">
        Raised by <span className="font-semibold text-ink-900">{complaint.userName ?? 'Unnamed'}</span>{' '}
        · +91 {complaint.userPhone}
        {complaint.orderNumber && (
          <>
            {' '}· Order{' '}
            <span className="font-mono font-semibold text-ink-900">{complaint.orderNumber}</span>
          </>
        )}{' '}
        · Last update {new Date(complaint.updatedAt).toLocaleString('en-IN')}
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs font-semibold text-gray-500">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ComplaintStatusValue)}
            className="mt-1 block rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none"
          >
            {COMPLAINT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-56 flex-1">
          <label className="text-xs font-semibold text-gray-500">Internal notes (admin only)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. Called the customer, refund initiated…"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
          />
        </div>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          {saved ? '✓ Saved' : busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

export default function AdminComplaintsPage() {
  const [tab, setTab] = useState<string>('OPEN');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AdminComplaintRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (tab !== 'ALL') params.set('status', tab);
    if (category) params.set('category', category);
    if (q.trim()) params.set('q', q.trim());
    api<AdminComplaintRow[]>(`/api/admin/complaints?${params.toString()}`, { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, [tab, category, q]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div>
      <h1 className="text-2xl font-bold">Complaints</h1>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${
              tab === t ? 'bg-ink-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t.replace('_', ' ')}
          </button>
        ))}
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold outline-none"
        >
          <option value="">All categories</option>
          {COMPLAINT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {COMPLAINT_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search CMP-…"
          className="rounded-full border border-gray-300 px-3.5 py-1.5 text-xs outline-none focus:border-brand-600"
        />
      </div>

      {rows === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && <p className="mt-6 text-sm text-gray-600">No complaints here. 🎉</p>}

      <div className="mt-4 space-y-3">
        {rows?.map((c) => (
          <div key={c.id} className="rounded-2xl border border-gray-100 bg-white p-4">
            <button
              onClick={() => setOpenId(openId === c.id ? null : c.id)}
              className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
            >
              <div className="min-w-0">
                <p className="font-mono text-sm font-bold text-brand-600">
                  {c.complaintId}
                  <span className="ml-2 font-sans text-xs font-normal text-gray-500">
                    {COMPLAINT_CATEGORY_LABELS[c.category]}
                    {c.orderNumber && <> · {c.orderNumber}</>}
                  </span>
                </p>
                <p className="mt-0.5 truncate text-sm text-gray-700">{c.description}</p>
                <p className="mt-0.5 text-xs text-gray-400">
                  {c.userName ?? 'Unnamed'} · +91 {c.userPhone} ·{' '}
                  {new Date(c.createdAt).toLocaleDateString('en-IN')}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[c.status]}`}>
                {c.status.replace('_', ' ')}
              </span>
            </button>
            {openId === c.id && <ComplaintDetail complaint={c} onUpdated={load} />}
            {openId === c.id && c.orderId && (
              <Link
                href={`/admin/orders`}
                className="mt-2 inline-block text-xs text-gray-500 hover:underline"
              >
                View in orders →
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
