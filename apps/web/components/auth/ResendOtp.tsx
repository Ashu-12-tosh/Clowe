'use client';

import { useEffect, useState } from 'react';
import type { OtpRequestResult } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

/**
 * "Didn't get the code?" under every OTP box: a countdown that matches the
 * server's resend cooldown, then a Resend button that says plainly what
 * happened. Every code sent in the last few minutes works, so a slow first
 * SMS that turns up after the resend is fine to use too.
 */
export default function ResendOtp({
  phone,
  firstSent,
  onSent,
}: {
  phone: string;
  /** The answer to the request that sent the first code. */
  firstSent: OtpRequestResult | null;
  /** A new code went out (the page clears the box; dev mode fills it). */
  onSent: (result: OtpRequestResult) => void;
}) {
  const [left, setLeft] = useState(firstSent?.resendAfterSec ?? 45);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  async function resend() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<OtpRequestResult>('/api/auth/request-otp', { body: { phone } });
      onSent(result);
      setLeft(result.resendAfterSec);
      const at = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      const minutes = Math.round(result.expiresInSec / 60);
      setNotice(
        `New code sent to +91 ${phone} at ${at}. If the earlier SMS arrives first, its code works too — any code from the last ${minutes} minutes.`,
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach Clowe. Check your connection and try again.');
      // The server's cooldown is the truth; a refused resend just waits a little.
      if (err instanceof ApiRequestError && err.code === 'OTP_COOLDOWN') {
        const wait = Number(/(\d+)s/.exec(err.message)?.[1]);
        if (wait > 0) setLeft(wait);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-center text-sm" aria-live="polite">
      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-green-800">{notice}</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-red-700">{error}</p>}
      <p className="text-gray-500">
        Didn&apos;t get the code?{' '}
        {left > 0 ? (
          <span>
            Resend in <span className="font-semibold tabular-nums">{left}s</span>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void resend()}
            disabled={busy}
            className="font-semibold text-brand-600 hover:underline disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Resend OTP'}
          </button>
        )}
      </p>
    </div>
  );
}
