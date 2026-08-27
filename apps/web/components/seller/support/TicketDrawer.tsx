'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  TICKET_PRIORITY_LABELS,
  type SupportTicketDetail,
  type TicketStatusValue,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

export const TICKET_STATUS_STYLES: Record<TicketStatusValue, string> = {
  OPEN: 'bg-yellow-100 text-yellow-700',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  RESOLVED: 'bg-green-100 text-green-700',
  CLOSED: 'bg-gray-100 text-gray-600',
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** One ticket: the whole conversation, plus reply / close / rate. */
export default function TicketDrawer({
  ticketId,
  onClose,
  onChanged,
}: {
  ticketId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [ticket, setTicket] = useState<SupportTicketDetail | null>(null);
  const [reply, setReply] = useState('');
  const [rating, setRating] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setTicket(await api<SupportTicketDetail>(`/api/seller/support/tickets/${ticketId}`, { auth: true }));
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load this ticket');
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function send() {
    if (reply.trim().length === 0) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/seller/support/tickets/${ticketId}/reply`, {
        method: 'POST',
        body: { body: reply.trim(), attachments: [] },
        auth: true,
      });
      setReply('');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send your reply');
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!confirm('Close this ticket? You can always open a new one.')) return;
    setBusy(true);
    try {
      await api(`/api/seller/support/tickets/${ticketId}/close`, { method: 'POST', auth: true });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not close the ticket');
    } finally {
      setBusy(false);
    }
  }

  async function rate(value: number) {
    setRating(value);
    setBusy(true);
    try {
      await api(`/api/seller/support/tickets/${ticketId}/rating`, {
        method: 'POST',
        body: { rating: value },
        auth: true,
      });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save your rating');
    } finally {
      setBusy(false);
    }
  }

  const settled = ticket?.status === 'RESOLVED' || ticket?.status === 'CLOSED';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-900/40" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-lg flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <p className="font-mono text-sm font-bold text-brand-600">
              {ticket?.reference ?? 'Loading…'}
            </p>
            <p className="truncate text-sm font-semibold text-ink-900">{ticket?.subject}</p>
            {ticket && (
              <p className="text-[11px] text-gray-500">
                {ticket.categoryLabel} · {TICKET_PRIORITY_LABELS[ticket.priority]} priority ·{' '}
                raised {fmt(ticket.createdAt)}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-full px-3 py-1 text-sm text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </header>

        {error && <p className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {ticket && (
          <>
            <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-2.5">
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${TICKET_STATUS_STYLES[ticket.status]}`}
              >
                {ticket.statusLabel}
              </span>
              {ticket.orderNumber && (
                <span className="rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600">
                  Order {ticket.orderNumber}
                </span>
              )}
              {ticket.firstResponseMinutes !== null && (
                <span className="text-[11px] text-gray-400">
                  First reply in {Math.round(ticket.firstResponseMinutes)}m
                </span>
              )}
            </div>

            {/* Conversation */}
            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {ticket.messages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
                    m.authorRole === 'SELLER'
                      ? 'ml-auto bg-ink-900 text-white'
                      : 'bg-cream-100 text-ink-900'
                  }`}
                >
                  <p className="whitespace-pre-line">{m.body}</p>
                  <p
                    className={`mt-1 text-[10px] ${
                      m.authorRole === 'SELLER' ? 'text-gray-300' : 'text-gray-500'
                    }`}
                  >
                    {m.authorRole === 'SELLER' ? 'You' : (m.authorName ?? 'Clowe support')} ·{' '}
                    {fmt(m.createdAt)}
                  </p>
                </div>
              ))}
            </div>

            {/* Rating, once the ticket is settled */}
            {settled && (
              <div className="border-t border-gray-100 px-5 py-3">
                {ticket.rating ? (
                  <p className="text-xs text-gray-500">
                    You rated this support {ticket.rating}/5 — thank you.
                  </p>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">How was this support?</span>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        disabled={busy}
                        onClick={() => void rate(n)}
                        className={`text-lg ${n <= rating ? 'text-brand-500' : 'text-gray-300'} hover:text-brand-500 disabled:opacity-50`}
                        aria-label={`Rate ${n} out of 5`}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Reply box */}
            {ticket.status !== 'CLOSED' ? (
              <div className="border-t border-gray-100 p-4">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  rows={3}
                  placeholder={
                    ticket.status === 'RESOLVED'
                      ? 'Still not sorted? Replying reopens the ticket.'
                      : 'Add more detail for the support team…'
                  }
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
                />
                <div className="mt-2 flex justify-between gap-2">
                  <button
                    onClick={() => void close()}
                    disabled={busy}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50"
                  >
                    Close ticket
                  </button>
                  <button
                    onClick={() => void send()}
                    disabled={busy || reply.trim().length === 0}
                    className="rounded-lg bg-ink-900 px-5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                  >
                    {busy ? 'Sending…' : 'Send reply'}
                  </button>
                </div>
              </div>
            ) : (
              <p className="border-t border-gray-100 p-4 text-xs text-gray-500">
                This ticket is closed. Raise a new one if you need more help.
              </p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
