'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiRequestError } from '@/lib/api';

/**
 * The one-time link from "Confirm your email address". It confirms only on a
 * click here, so a mail scanner that opens links can't use it up.
 */
function VerifyEmailInner() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'ready' | 'busy' | 'done' | 'error'>(token ? 'ready' : 'error');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState(token ? '' : 'This link is incomplete. Ask for a new one in My Account.');

  async function confirm() {
    setState('busy');
    try {
      const r = await api<{ email: string }>('/api/auth/verify-email', { method: 'POST', body: { token } });
      setEmail(r.email);
      setState('done');
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : 'Could not reach Clowe. Please try again.');
      setState('error');
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center" data-verify-email>
      <h1 className="t-page-title text-ink-900">Confirm your email</h1>
      {state === 'done' ? (
        <>
          <p className="mt-3 text-sm text-gray-600" data-verify-done>
            Thank you — <strong className="text-ink-900">{email}</strong> is confirmed. Your order updates and invoices will come here.
          </p>
          <Link href="/account" className="mt-6 inline-block rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-semibold text-white">
            Go to My Account
          </Link>
        </>
      ) : state === 'error' ? (
        <>
          <p className="mt-3 text-sm text-red-600" data-verify-error>{message}</p>
          <Link href="/account" className="mt-6 inline-block rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-semibold text-ink-900">
            My Account
          </Link>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm text-gray-600">One click and your order updates and invoices can come to this address.</p>
          <button
            type="button"
            disabled={state === 'busy'}
            onClick={() => void confirm()}
            className="mt-6 rounded-xl bg-ink-900 px-6 py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            {state === 'busy' ? 'Confirming…' : 'Confirm my email'}
          </button>
        </>
      )}
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailInner />
    </Suspense>
  );
}
