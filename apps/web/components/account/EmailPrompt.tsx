'use client';

import { useEffect, useState } from 'react';
import { customerEmailSchema, type AuthUser } from '@clowe/shared';
import { api, ApiRequestError, setStoredUser } from '@/lib/api';

const DISMISS_KEY = 'clowe_email_prompt_dismissed';
const DISMISS_DAYS = 14;

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return at > 0 && Date.now() - at < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

/**
 * My Account: a gentle nudge to add an email address (order updates and
 * invoices), or to confirm the one on the account. "Not now" hides it for two
 * weeks. Signing in stays SMS OTP; this is only where emails go.
 */
export default function EmailPrompt() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hidden, setHidden] = useState(true);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');

  useEffect(() => {
    setHidden(dismissedRecently());
    api<AuthUser>('/api/auth/me', { auth: true })
      .then((me) => {
        setUser(me);
        setStoredUser(me);
      })
      .catch(() => {});
  }, []);

  if (!user || user.emailVerified || (hidden && !sentTo)) return null;

  function notNow() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // private mode: hidden for this visit only
    }
    setHidden(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = customerEmailSchema.safeParse(email);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Enter a valid email address');
    setBusy(true);
    setError('');
    try {
      const me = await api<AuthUser>('/api/auth/me', { method: 'PATCH', auth: true, body: { email: parsed.data } });
      setUser(me);
      setStoredUser(me);
      setSentTo(me.email ?? parsed.data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save your email');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ email: string }>('/api/auth/me/email/resend', { method: 'POST', auth: true });
      setSentTo(r.email);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send the link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-brand-100 bg-brand-50 p-4" data-email-prompt>
      {sentTo ? (
        <p className="text-sm text-ink-900">
          📧 We sent a link to <strong>{sentTo}</strong>. Open it to confirm your email — it works once, for 48 hours.
        </p>
      ) : user.email ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-900">
            📧 Please confirm <strong>{user.email}</strong> — open the link we emailed you, so your order updates and invoices can go there.
          </p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void resend()} className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              Send the link again
            </button>
            <button type="button" onClick={notNow} className="px-2 text-xs font-semibold text-gray-500 hover:text-ink-900">
              Not now
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void save(e)} noValidate>
          <p className="text-sm font-semibold text-ink-900">📧 Get your order updates and invoices by email</p>
          <p className="mt-0.5 text-xs text-gray-600">Optional. You&apos;ll still sign in with your phone; we&apos;ll send one link to confirm the address.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Email address"
              className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
            />
            <button type="submit" disabled={busy || !email.trim()} className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Save
            </button>
            <button type="button" onClick={notNow} className="px-2 text-xs font-semibold text-gray-500 hover:text-ink-900">
              Not now
            </button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}
