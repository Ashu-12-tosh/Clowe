'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { GATEWAY_PAYMENT_KINDS, safeHref, type GatewayPaymentKind, type PaymentConfirmResult } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { confirmPayment, payWithCashfree } from '@/lib/cashfree';
import { forgetCheckoutKey } from '@/lib/checkoutKey';
import { returnView } from '@/lib/paymentView';

/** While the answer is not final, the page asks again on its own this often, for this long. */
const AUTO_CHECK_MS = 5000;
const AUTO_CHECK_FOR_MS = 3 * 60_000;

/** No answer from the server at all (offline, a timeout, a 5xx): try again later. */
function isConnectionProblem(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false;
  return ['NETWORK_ERROR', 'BAD_RESPONSE', 'TOO_MANY_REQUESTS', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'].includes(err.code);
}

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
  // From "Retry payment" on the order: open the payment once the check says it can still be paid.
  const payWhenReady = useRef(params.get('pay') === '1');

  const [result, setResult] = useState<PaymentConfirmResult | null>(null);
  const [busy, setBusy] = useState(true);
  // The server could not be asked (offline, a timeout): nothing is known about
  // the payment, so nothing is said about it. "Nothing was charged" is only
  // ever the server's answer, never a guess (pre-launch test H3).
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);
  const since = useRef(Date.now());
  // A check still running after this long gets a "Check again" beside it.
  const [slow, setSlow] = useState(false);
  // Opening the payment again: the only thing that greys out "Complete payment".
  const [paying, setPaying] = useState(false);

  const settle = useCallback(
    (r: PaymentConfirmResult) => {
      if (r.outcome === 'PAID' && kind) {
        if (kind === 'ORDER') forgetCheckoutKey();
        router.replace(DONE[kind](id));
        return;
      }
      if (r.outcome === 'FAILED' && kind === 'ORDER') forgetCheckoutKey();
      setResult(r);
    },
    [kind, id, router],
  );

  // The check running now: a new one (Check again, the connection back)
  // cancels it, and only the latest one may change what the page shows.
  const running = useRef<AbortController | null>(null);
  // The first check after coming back waits a little for the bank (a few
  // asks); the automatic re-checks after it are one quiet ask each, which
  // neither greys out the buttons nor flips the page to "Checking…".
  const check = useCallback(async ({ quiet = false, attempts = 1 }: { quiet?: boolean; attempts?: number } = {}) => {
    if (!kind || !id) return;
    running.current?.abort();
    const mine = new AbortController();
    running.current = mine;
    // Let the cancelled request leave the client's in-flight list first, so this one is really sent.
    await new Promise((r) => setTimeout(r, 0));
    if (mine.signal.aborted) return;
    if (!quiet) {
      setBusy(true);
      setError('');
      setSlow(false);
    }
    const slowTimer = quiet ? undefined : window.setTimeout(() => setSlow(true), 15_000);
    try {
      const r = await confirmPayment(kind, id, { attempts, intervalMs: 3000, signal: mine.signal });
      if (mine.signal.aborted) return;
      settle(r);
      setUnreachable(false);
    } catch (err) {
      if (mine.signal.aborted) return;
      if (isConnectionProblem(err)) setUnreachable(true);
      else setError(err instanceof Error ? err.message : 'Could not check the payment');
    } finally {
      if (slowTimer) window.clearTimeout(slowTimer);
      if (running.current === mine && !quiet) {
        setSlow(false);
        setBusy(false);
      }
    }
  }, [kind, id, settle]);

  useEffect(() => {
    if (!getStoredUser()) {
      router.replace('/login');
      return;
    }
    if (started.current) return;
    started.current = true;
    void check({ attempts: 6 });
  }, [check, router]);

  // Not final yet (the bank is deciding, or the server could not be reached):
  // ask again every few seconds for a while, and as soon as the connection is back.
  const waiting = !busy && !paying && (unreachable || (result !== null && returnView({ unreachable, result }) === 'WAITING'));
  // The bank deciding, or no connection: ask often. An order simply not paid
  // yet: now and then — each ask is a call to the gateway.
  const autoEveryMs = unreachable || result?.attemptPending ? AUTO_CHECK_MS : 3 * AUTO_CHECK_MS;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!waiting) return;
    const onLine = () => void check({ quiet: true });
    window.addEventListener('online', onLine);
    const timer =
      Date.now() - since.current < AUTO_CHECK_FOR_MS
        ? window.setTimeout(() => void check({ quiet: true }).finally(() => setTick((t) => t + 1)), autoEveryMs)
        : undefined;
    return () => {
      window.removeEventListener('online', onLine);
      if (timer) window.clearTimeout(timer);
    };
  }, [waiting, check, autoEveryMs, tick]);

  useEffect(() => {
    if (!payWhenReady.current || busy || paying || !result?.checkout || result.attemptPending) return;
    // The test gateway pays with a click only, never by itself.
    if (result.checkout.provider === 'mock') return;
    if (result.outcome !== 'PENDING' && result.outcome !== 'RETRY') return;
    payWhenReady.current = false;
    void tryAgain();
    // tryAgain reads the result it is called with; it is not a dependency to re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, result]);

  async function tryAgain() {
    if (!kind || !result?.checkout) return;
    // An automatic check in the background must not land while the window is open.
    running.current?.abort();
    setPaying(true);
    setError('');
    try {
      if (result.checkout.provider === 'mock' && kind === 'ORDER') {
        // The test gateway (staging/dev): no window to open.
        await api('/api/payments/mock-pay', { body: { orderId: id, outcome: 'success' }, auth: true });
        settle(await confirmPayment(kind, id, { attempts: 1 }));
      } else {
        settle(await payWithCashfree(kind, id, result.checkout));
      }
    } catch (err) {
      // The window may have taken the money before the answer was lost: ask, do not guess.
      if (isConnectionProblem(err)) setUnreachable(true);
      else setError(err instanceof Error ? err.message : 'Could not open the payment window');
    } finally {
      setPaying(false);
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
  const view = error && !result && !busy ? 'ERROR' : returnView({ unreachable, result });
  const autoChecking = Date.now() - since.current < AUTO_CHECK_FOR_MS;
  const keepTrying = autoChecking ? ' We will keep trying.' : ' Press Check again to try once more.';
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="rounded-2xl border border-gray-200 bg-white p-6 text-center">
        {view === 'ERROR' ? (
          <>
            <h1 className="t-sub-heading text-ink-900">We could not check this payment</h1>
            <p className="t-caption mt-2 text-gray-500">
              If money left your account it is safe: it will be confirmed on your order, or refunded in full.
            </p>
            <button
              onClick={() => void check()}
              disabled={busy}
              className="t-btn mt-6 w-full rounded-lg bg-brand-600 py-2.5 text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Check again
            </button>
          </>
        ) : view === 'CHECKING' ? (
          <>
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-brand-100 border-t-brand-600" aria-hidden />
            <h1 className="t-sub-heading mt-4 text-ink-900">We&apos;re checking your payment…</h1>
            <p className="t-caption mt-2 text-gray-500" role="status">
              {unreachable
                ? `We could not check it yet.${keepTrying} If money left your account it is safe: it will be confirmed here, or refunded in full.`
                : 'This takes a few seconds. Please keep this page open.'}
            </p>
            {(unreachable || slow) && (
              <button
                onClick={() => void check()}
                disabled={busy && !slow}
                className="t-btn mt-6 w-full rounded-lg bg-brand-600 py-2.5 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy && !slow ? 'Checking…' : 'Check again'}
              </button>
            )}
          </>
        ) : view === 'WAITING' ? (
          <>
            <h1 className="t-sub-heading text-ink-900">
              {result?.attemptPending || unreachable ? 'Waiting for your bank' : 'Payment not finished yet'}
            </h1>
            <p className="t-caption mt-2 text-gray-500" role="status">
              {unreachable
                ? `We could not check it again just now.${keepTrying}`
                : result?.attemptPending
                  ? (result.message ?? 'Your bank has not confirmed the payment yet.')
                  : (result?.message ?? (result?.outcome === 'PENDING' ? 'We have not received a payment for this order yet.' : 'We are still checking this payment.'))}{' '}
              If money left your account it will be confirmed here shortly, or refunded in full if it cannot be.
            </p>
            {result?.checkout && !result.attemptPending && !unreachable && (
              <button
                onClick={() => void tryAgain()}
                disabled={paying}
                className="t-btn mt-6 w-full rounded-lg bg-brand-600 py-2.5 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {paying ? 'Please wait…' : 'Complete payment'}
              </button>
            )}
            <button
              onClick={() => void check()}
              disabled={busy}
              className="t-btn mt-3 w-full rounded-lg border border-gray-300 py-2.5 text-ink-900 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Check again'}
            </button>
            {kind === 'ORDER' && result?.outcome === 'PENDING' && !result.checkout && !result.attemptPending && !unreachable && (
              <Link href="/cart" className="t-caption mt-3 inline-block text-brand-700 underline">
                Check out again from your cart
              </Link>
            )}
          </>
        ) : view === 'RETRY' && result ? (
          <>
            <h1 className="t-sub-heading text-ink-900">The payment did not go through</h1>
            <p className="t-caption mt-2 text-gray-500">{result.message ?? 'Nothing was charged.'} You can try again.</p>
            {result.checkout && (
              <button
                onClick={() => void tryAgain()}
                disabled={paying}
                className="t-btn mt-6 w-full rounded-lg bg-brand-600 py-2.5 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {paying ? 'Please wait…' : 'Try again'}
              </button>
            )}
          </>
        ) : view === 'FAILED' && result ? (
          <>
            <h1 className="t-sub-heading text-ink-900">Payment not completed</h1>
            <p className="t-caption mt-2 text-gray-500">{result.message ?? 'This payment could not be completed. Nothing was charged.'}</p>
          </>
        ) : null}
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
