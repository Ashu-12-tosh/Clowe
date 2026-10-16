'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';

interface EmailRow {
  id: string;
  kind: string;
  toEmail: string;
  subject: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}
interface EmailView {
  provider: 'smtp' | 'mock';
  from: string;
  replyTo: string;
  dailyCap: number;
  loginError: string | null;
  heldUntil: string | null;
  sentToday: number;
  pending: number;
  failed: number;
  recent: EmailRow[];
}

const STATUS_STYLE: Record<string, string> = {
  SENT: 'bg-green-50 text-green-700',
  PENDING: 'bg-amber-50 text-amber-700',
  SENDING: 'bg-amber-50 text-amber-700',
  FAILED: 'bg-red-50 text-red-700',
};

/**
 * Email from no-reply@cloweshop.com: today's count against the daily cap, the
 * queue (failed sends retry on their own), the latest emails, and a test send.
 */
export default function AdminEmailsPage() {
  const [view, setView] = useState<EmailView | null>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<EmailView>('/api/admin/emails', { auth: true })
      .then(setView)
      .catch((e) => setError(e instanceof ApiRequestError ? e.message : 'Could not load'));
  }, []);
  useEffect(load, [load]);

  async function sendTest() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ view: EmailView }>('/api/admin/emails/test', { method: 'POST', auth: true, body: { to }, success: 'Test email queued' });
      setView(r.view);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Not sent');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-admin-emails>
      <div>
        <h1 className="text-2xl font-bold">Emails</h1>
        <p className="text-sm text-gray-500">
          {view ? `${view.from} · replies to ${view.replyTo} · ${view.provider === 'smtp' ? 'Hostinger SMTP' : 'mock (not sent)'}` : '…'}
        </p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {view?.loginError && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" data-email-login-error>
          Hostinger refused the login for {view.from}: {view.loginError}. Emails are waiting, not lost
          {view.heldUntil ? ` — next try ${new Date(view.heldUntil).toLocaleTimeString('en-IN')}` : ''}. Check the mailbox and its password (SMTP_PASSWORD), then send a test.
        </p>
      )}
      {view && (
        <>
          <section className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <p className="text-xs text-gray-500">Sent today</p>
              <p className="text-xl font-bold">
                {view.sentToday} <span className="text-sm font-normal text-gray-500">of {view.dailyCap}</span>
              </p>
              <p className="text-[11px] text-gray-500">Past the cap, emails wait for tomorrow (India time).</p>
            </div>
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <p className="text-xs text-gray-500">Waiting</p>
              <p className="text-xl font-bold">{view.pending}</p>
              <p className="text-[11px] text-gray-500">Failed sends retry after 1, 5, 30, 120 and 360 minutes.</p>
            </div>
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <p className="text-xs text-gray-500">Gave up</p>
              <p className="text-xl font-bold">{view.failed}</p>
            </div>
          </section>
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold">Send a test email</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                type="email"
                name="to"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="support@cloweshop.com"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
              <button type="button" disabled={busy || !to} onClick={() => void sendTest()} className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                Send test
              </button>
            </div>
          </section>
          <section className="overflow-x-auto rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold">Latest emails</h2>
            <table className="mt-2 w-full text-xs">
              <tbody>
                {view.recent.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 align-top">
                    <td className="py-1.5 pr-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString('en-IN')}</td>
                    <td className="pr-2">{r.kind}</td>
                    <td className="pr-2">{r.toEmail}</td>
                    <td className="pr-2">
                      {r.subject}
                      {r.lastError && <span className="block text-red-600">{r.lastError}</span>}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <span className={`rounded px-1.5 py-0.5 ${STATUS_STYLE[r.status] ?? ''}`}>{r.status}</span>
                      {r.attempts > 1 && <span className="ml-1 text-gray-500">×{r.attempts}</span>}
                    </td>
                  </tr>
                ))}
                {view.recent.length === 0 && (
                  <tr>
                    <td className="py-2 text-gray-500">No emails yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
