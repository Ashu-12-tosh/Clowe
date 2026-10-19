'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { GATEWAY_PAYMENT_KINDS, safeHref, type GatewayPaymentKind, type PaymentConfirmResult } from '@clowe/shared';
import { getStoredUser } from '@/lib/api';
import { confirmPayment, payWithCashfree } from '@/lib/cashfree';

/** Where each kind of payment goes once it is paid, and back to when it is not. */
const DONE: Record<GatewayPaymentKind, (id: string) => string> = {
  ORDER: (id) => `/orders/${id}/confirmation`,
  CREDITS: () => '/account/credits',
  PROMOTION: () => '/seller/billing',
};
const BACK: Record<GatewayPaymentKind, { href: (id: string) => string; label: string }> = {
  ORDER: { href: (id) => `/account/orders/${id}`, label: 'View the order' },
  CREDITS: { href: () => '/account/credits', label: 'Back to Clowe Credits' },
  PROMOTION: { href: () => '/seller/billing', label: 'Back to billing' },
};

/**
 * Where the browser lands after paying away from the page (a bank's page, a
 * UPI app) — and where checkout sends a payment the bank has not decided yet.
 * It asks the server, which asks Cashfree; it never takes the address bar's
 * word that anything was paid.
 */
function ReturnInner() {
  const router = useRouter();
  const params = useSearchParams();
  const kindParam = params.get('kind') ?? '';
  const id = params.get('id') ?? '';
  const kind = (GATEWAY_PAYMENT_KINDS as readonly string[]).includes(kindParam) ? (kindParam as GatewayPaymentKind) : null;

  const [result, setResult] = useState<PaymentConfirmResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const started = useRef(false);

  const settle = useCallback(
    (r: PaymentConfirmResult) => {
      if (r.outcome === 'PAID' && kind) {
        router.replace(DONE[kind](id));
        return;
      }
      setResult(r);
    },
    [kind, id, router],
  );

  const check = useCallback(async () => {
    if (!kind || !id) return;
    setBusy(true);
    setError('');
    try {
      settle(await confirmPayment(kind, id, { attempts: 10, intervalMs: 3000 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check the payment');
    } finally {
      setBusy(false);
    }
  }, [kind, id, settle]);

  useEffect(() => {
    if (!getStoredUser()) {
      router.replace('/login');
      return;
    }
    if (started.current) return;
    started.current = true;
    void check();
  }, [check, router]);

  async function tryAgain() {
    if (!kind || !result?.checkout) return;
    setBusy(true);
    setError('');
    try {
      settle(await payWithCashfree(kind, id, result.checkout));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the payment window');
    } finally {
      setBusy(false);
    }
  }

  if (!kind || !id) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="t-sub-heading text-ink-900">Nothing to check here</h1>
        <Link href="/" className="t-btn mt-6 inline-block rounded-lg bg-brand-600 px-5 py-2.5 text-white">
          Continue shopping
        </Link>
      </main>
    );
  }

  const back = BACK[kind];
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="rounded-2xl border border-gray-200 bg-white p-6 text-center">
        {busy && !result ? (
          <>
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-brand-100 border-t-brand-600" aria-hidden />
            <h1 className="t-sub-heading mt-4 text-ink-900">Checking your payment…</h1>
            <p className="t-caption mt-2 text-gray-500">This takes a few seconds. Please keep this page open.</p>
          </>
        ) : result?.outcome === 'PENDING' ? (
          <>
            <h1 className="t-sub-heading text-ink-900">Waiting for your bank</h1>
            <p className="t-caption mt-2 text-gray-500">
              {result.message ?? 'Your bank has not confirmed the payment yet.'} If money left your account it will be
              confirmed here shortly — or refunded in full if it cannot be.
            </p>
            <button
              onClick={() => void check()}
              disabled={busy}
              className="t-btn mt-6 w-full rounded-lg bg-brand-600 py-2.5 text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Check again'}
            </button>
          </>
        ) : result?.outcome === 'RETRY' ? (
          <>
            <h1 className="t-sub-heading text-ink-900">The payment did not go through</h1>
            <p className="t-caption mt-2 text-gray-500">{result.message ?? 'Nothing was charged.'} You can try again.</p>
            {result.checkout && (
              <button
                onClick={() => void tryAgain()}
                disabled={busy}
                className="t-btn mt-6 w-full rounded-lg bg-brand-600 py-2.5 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? 'Please wait…' : 'Try again'}
              </button>
            )}
          </>
        ) : (
          <>
            <h1 className="t-sub-heading text-ink-900">Payment not completed</h1>
            <p className="t-caption mt-2 text-gray-500">{result?.message ?? 'This payment could not be completed. Nothing was charged.'}</p>
          </>
        )}
        {error && <p className="t-caption mt-3 text-red-600">{error}</p>}
        <Link href={safeHref(back.href(id)) ?? '/'} className="t-caption mt-5 inline-block text-brand-700 underline">
          {back.label}
        </Link>
      </div>
    </main>
  );
}

export default function CheckoutReturnPage() {
  return (
    <Suspense fallback={null}>
      <ReturnInner />
    </Suspense>
  );
}
