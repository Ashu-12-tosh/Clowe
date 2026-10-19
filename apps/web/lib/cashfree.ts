import type { GatewayCheckout, GatewayPaymentKind, PaymentConfirmResult } from '@clowe/shared';
import { api } from './api';

// ---------------------------------------------------------------------------
// Cashfree's browser checkout (JS SDK v3), and asking our server afterwards
// whether the payment went through. The browser's own account of the payment
// is never trusted: the server asks Cashfree, every time.
// ---------------------------------------------------------------------------

interface CashfreeCheckoutResult {
  error?: { message?: string };
  redirect?: boolean;
  paymentDetails?: { paymentMessage?: string };
}
interface CashfreeInstance {
  checkout(options: { paymentSessionId: string; redirectTarget?: '_modal' | '_self' | '_blank' }): Promise<CashfreeCheckoutResult>;
}

declare global {
  interface Window {
    Cashfree?: (options: { mode: 'sandbox' | 'production' }) => CashfreeInstance;
  }
}

export const CASHFREE_SDK_URL = 'https://sdk.cashfree.com/js/v3/cashfree.js';

let loading: Promise<void> | null = null;

/** Load the SDK once per page. */
export function loadCashfree(): Promise<void> {
  if (typeof window !== 'undefined' && window.Cashfree) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CASHFREE_SDK_URL;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load the payment window'));
    };
    document.body.appendChild(script);
  });
  return loading;
}

/**
 * Open Cashfree's checkout over the page. Resolves when the shopper finishes
 * or closes it — which says nothing about whether money moved: ask
 * confirmPayment. 'REDIRECTED' means the browser is leaving for the bank or
 * UPI app; the return page picks up from there.
 */
export async function openCashfreeCheckout(checkout: GatewayCheckout): Promise<'DONE' | 'CLOSED' | 'REDIRECTED'> {
  if (checkout.provider !== 'cashfree' || !checkout.paymentSessionId) throw new Error('This payment cannot be opened here');
  await loadCashfree();
  if (!window.Cashfree) throw new Error('Could not load the payment window');
  const cashfree = window.Cashfree({ mode: checkout.mode === 'production' ? 'production' : 'sandbox' });
  const result = await cashfree.checkout({ paymentSessionId: checkout.paymentSessionId, redirectTarget: '_modal' });
  if (result.redirect) return 'REDIRECTED';
  if (result.error) return 'CLOSED';
  return 'DONE';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the server what happened to a gateway payment. While the bank has not
 * answered (PENDING) it asks again, a few times, before handing PENDING back.
 */
export async function confirmPayment(
  kind: GatewayPaymentKind,
  id: string,
  { attempts = 8, intervalMs = 3000 }: { attempts?: number; intervalMs?: number } = {},
): Promise<PaymentConfirmResult> {
  let last: PaymentConfirmResult = { outcome: 'PENDING', message: null, checkout: null };
  for (let i = 0; i < attempts; i++) {
    last = await api<PaymentConfirmResult>('/api/payments/confirm', { body: { kind, id }, auth: true, quiet: true });
    if (last.outcome !== 'PENDING') return last;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return last;
}

/** Open the checkout and confirm with the server: the whole pay step for any gateway payment. */
export async function payWithCashfree(kind: GatewayPaymentKind, id: string, checkout: GatewayCheckout): Promise<PaymentConfirmResult> {
  const opened = await openCashfreeCheckout(checkout);
  if (opened === 'REDIRECTED') return { outcome: 'PENDING', message: null, checkout: null };
  // Closed without paying is still worth one ask: a UPI payment can finish in
  // the app after the window closed.
  return confirmPayment(kind, id, opened === 'CLOSED' ? { attempts: 1 } : {});
}
