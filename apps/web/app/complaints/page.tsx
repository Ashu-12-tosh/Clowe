'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ComplaintRow } from '@clowe/shared';
import { COMPLAINT_CATEGORY_LABELS, nextSupportLevel, SUPPORT_LEVEL_LABELS } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';

const STATUS_STYLES: Record<string, string> = {
  OPEN: 'bg-yellow-100 text-yellow-700',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  RESOLVED: 'bg-green-100 text-green-700',
  CLOSED: 'bg-gray-100 text-gray-600',
};

export default function MyComplaintsPage() {
  const [rows, setRows] = useState<ComplaintRow[] | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);

  const [note, setNote] = useState('');
  const load = () =>
    api<ComplaintRow[]>('/api/complaints/me', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    void load();
  }, []);

  /** Not satisfied: up to the Nodal Officer, then the Grievance Officer (Grievance Policy 3.1). */
  async function escalate(c: ComplaintRow) {
    const reason = window.prompt('Why are you not satisfied with the answer so far?');
    if (!reason || reason.trim().length < 5) return;
    try {
      await api(`/api/complaints/${c.id}/escalate`, { auth: true, quiet: true, body: { reason: reason.trim() } });
      setNote(`${c.complaintId} escalated — you will hear back within the time shown.`);
      void load();
    } catch (err) {
      setNote(err instanceof ApiRequestError ? err.message : 'Could not escalate it');
    }
  }

  if (loggedOut) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">My Complaints</p>
        <p className="mt-2 text-sm text-gray-600">
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Login
          </Link>{' '}
          to see your complaints.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold">My Complaints 📢</h1>
      <p className="mt-1 text-sm text-gray-500">
        Raised via the support chat (💬 bottom-right). Our team updates the status here.
      </p>

      {rows === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No complaints — great! If something goes wrong, open the 💬 chat and tap
          &ldquo;Raise a complaint&rdquo;.
        </p>
      )}

      {note && <p className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-sm text-gray-700">{note}</p>}
      <div className="mt-4 space-y-3">
        {rows?.map((c) => (
          <div key={c.id} className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-sm font-bold text-brand-600">{c.complaintId}</p>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[c.status]}`}>
                {c.status.replace('_', ' ')}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              {COMPLAINT_CATEGORY_LABELS[c.category]}
              {c.orderNumber && <> · Order {c.orderNumber}</>} ·{' '}
              {new Date(c.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </p>
            <p className="mt-2 text-sm text-gray-700">{c.description}</p>
            {c.level && (
              <p className="mt-2 text-xs text-gray-500">
                {SUPPORT_LEVEL_LABELS[c.level]}
                {c.resolveDueAt && c.status !== 'RESOLVED' && c.status !== 'CLOSED' && (
                  <> · to be resolved by {new Date(c.resolveDueAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</>
                )}
              </p>
            )}
            {c.level && nextSupportLevel(c.level) && c.status !== 'CLOSED' && (
              <button
                onClick={() => void escalate(c)}
                className="mt-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-brand-600"
              >
                Not satisfied? Escalate to the {SUPPORT_LEVEL_LABELS[nextSupportLevel(c.level)!].split('— ')[1]}
              </button>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
