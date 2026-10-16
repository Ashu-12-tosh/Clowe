'use client';

import { useCallback, useEffect, useState } from 'react';
import { SELLER_RESPONSE_HOURS, type SellerComplaintRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const WHO: Record<string, string> = { CUSTOMER: 'Buyer', AGENT: 'Clowe support', SELLER: 'You', SYSTEM: 'Clowe' };

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/**
 * Complaints about your products, sent to you by Clowe support (Customer
 * Support and Grievance Policy 2.4): answer each within 24 hours; the buyer
 * sees your reply in their ticket.
 */
export default function SellerCustomerComplaintsPage() {
  const [rows, setRows] = useState<SellerComplaintRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<SellerComplaintRow[]>('/api/seller/customer-complaints', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  async function reply(id: string) {
    const body = (drafts[id] ?? '').trim();
    if (body.length < 2) return;
    setBusy(id);
    setError('');
    try {
      await api(`/api/seller/customer-complaints/${id}/reply`, { auth: true, body: { body }, success: 'Reply sent to the buyer' });
      setDrafts((d) => ({ ...d, [id]: '' }));
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send the reply');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Customer complaints</h1>
        <p className="mt-1 text-sm text-gray-500">
          Complaints about your products, sent to you by Clowe support. Answer each within {SELLER_RESPONSE_HOURS} hours — the buyer
          sees your reply.
        </p>
      </div>
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {rows === null && <p className="text-sm text-gray-500">Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-gray-600">No complaints about your products.</p>}
      {rows?.map((c) => (
        <section key={c.id} className="rounded-2xl border border-gray-100 bg-white p-4" data-seller-complaint>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-sm font-bold text-brand-600">
              {c.reference}
              {c.orderNumber && <span className="ml-2 font-sans text-xs font-normal text-gray-500">Order {c.orderNumber}</span>}
            </p>
            {c.respondedAt ? (
              <span className="rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700">Answered</span>
            ) : (
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${c.overdue ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}
              >
                {c.overdue ? 'Overdue' : c.dueAt ? `Answer by ${when(c.dueAt)}` : 'Awaiting your answer'}
              </span>
            )}
          </div>
          <ul className="mt-3 space-y-2">
            {c.messages.map((m, i) => (
              <li key={i} className="rounded-lg bg-cream-50 px-3 py-2 text-sm text-gray-700">
                <span className="text-xs font-semibold text-gray-500">
                  {WHO[m.authorRole] ?? m.authorRole} · {when(m.createdAt)}
                </span>
                <p className="mt-0.5 whitespace-pre-line">{m.body}</p>
              </li>
            ))}
          </ul>
          {c.status !== 'CLOSED' && (
            <div className="mt-3 flex gap-2">
              <textarea
                name="reply"
                value={drafts[c.id] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                rows={2}
                maxLength={2000}
                placeholder="Your answer to the buyer"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
              <button
                onClick={() => void reply(c.id)}
                disabled={busy === c.id || (drafts[c.id] ?? '').trim().length < 2}
                className="shrink-0 self-end rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white disabled:opacity-50"
              >
                {busy === c.id ? 'Sending…' : 'Reply'}
              </button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
