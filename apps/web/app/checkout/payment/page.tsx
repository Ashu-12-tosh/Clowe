'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ADDRESS_LABEL_TEXT,
  COD_MAX_PAISE,
  CREDIT_VALUE_PAISE,
  creditsToPaise,
  EMI_MIN_PAISE,
  PAYMENT_METHOD_META,
  PAYMENT_METHODS,
  type AddressInfo,
  type CartView,
  type CheckoutResult,
  type CreditsInfo,
  type DeliveryMethod,
  type DeliveryOption,
  type PaymentMethod,
  type SavedPaymentMethodInfo,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import CheckoutStepper from '@/components/checkout/CheckoutStepper';
import {
  BoxIcon,
  CardIcon,
  HeadsetIcon,
  LockIcon,
  PlusIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns on eligible items' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

const SECURITY_MARKS = ['PCI DSS', 'Verified by Visa', 'Mastercard SecureCode', 'RuPay Secure'];
const UPI_APPS = ['Google Pay', 'PhonePe', 'Paytm', 'BHIM', 'Amazon Pay'];
const CARD_NETWORKS = ['Visa', 'Mastercard', 'RuPay', 'Amex'];
const BANKS = ['HDFC Bank', 'ICICI Bank', 'State Bank of India', 'Axis Bank', 'Kotak Mahindra'];
const WALLETS = ['Paytm', 'Amazon Pay', 'PhonePe', 'Mobikwik'];

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function loadRazorpayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Razorpay'));
    document.body.appendChild(script);
  });
}

/** `name@bank` — the format every UPI handle follows. */
const UPI_ID_RE = /^[a-z0-9.\-_]{2,64}@[a-z]{2,32}$/i;

function fmtShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function PaymentPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const addressId = searchParams.get('addressId') ?? '';
  const deliveryMethod = (searchParams.get('deliveryMethod') ?? 'STANDARD') as DeliveryMethod;
  const useCredits = searchParams.get('useCredits') === 'true';
  const isGift = searchParams.get('isGift') === 'true';
  const giftMessage = searchParams.get('giftMessage') ?? '';

  const [cart, setCart] = useState<CartView | null>(null);
  const [addresses, setAddresses] = useState<AddressInfo[]>([]);
  const [credits, setCredits] = useState<CreditsInfo | null>(null);
  const [options, setOptions] = useState<DeliveryOption[]>([]);
  const [savedMethods, setSavedMethods] = useState<SavedPaymentMethodInfo[]>([]);

  const [method, setMethod] = useState<PaymentMethod>('UPI');
  const [billingId, setBillingId] = useState('');
  const [upiId, setUpiId] = useState('');
  const [upiState, setUpiState] = useState<'idle' | 'ok' | 'bad'>('idle');
  const [bank, setBank] = useState(BANKS[0]);
  const [wallet, setWallet] = useState(WALLETS[0]);

  const [placing, setPlacing] = useState(false);
  const [mockOrder, setMockOrder] = useState<CheckoutResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getStoredUser()) {
      router.replace('/login');
      return;
    }
    if (!addressId) {
      router.replace('/checkout');
      return;
    }
    api<CartView>('/api/cart', { auth: true }).then(setCart).catch(() => {});
    api<CreditsInfo>('/api/credits', { auth: true }).then(setCredits).catch(() => {});
    api<DeliveryOption[]>('/api/cart/delivery-options', { auth: true })
      .then(setOptions)
      .catch(() => {});
    api<SavedPaymentMethodInfo[]>('/api/me/payment-methods', { auth: true })
      .then(setSavedMethods)
      .catch(() => {});
    api<AddressInfo[]>('/api/addresses', { auth: true })
      .then((list) => {
        setAddresses(list);
        setBillingId(addressId);
      })
      .catch(() => {});
  }, [router, addressId]);

  // --- Totals: same maths the server re-runs when the order is created. ----
  const lines = useMemo(() => cart?.lines.filter((l) => l.selected) ?? [], [cart]);
  const chosenDelivery = options.find((o) => o.method === deliveryMethod) ?? null;
  const shippingPaise = chosenDelivery?.pricePaise ?? cart?.shippingPaise ?? 0;
  const itemTotalPaise = cart?.subtotalPaise ?? 0;
  const couponDiscountPaise = cart?.couponDiscountPaise ?? 0;
  const beforeCredits = itemTotalPaise + shippingPaise - couponDiscountPaise;
  const creditsUsable =
    useCredits && credits
      ? Math.min(credits.balance, Math.floor(Math.max(0, beforeCredits - 100) / CREDIT_VALUE_PAISE))
      : 0;
  const creditsDiscountPaise = creditsToPaise(creditsUsable);
  const totalPaise = beforeCredits - creditsDiscountPaise;
  const savingsPaise = (cart?.discountPaise ?? 0) + couponDiscountPaise + creditsDiscountPaise;
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const shipTo = addresses.find((a) => a.id === addressId) ?? null;

  /** Why a method can't be used right now — null when it can. */
  function unavailableReason(m: PaymentMethod): string | null {
    if (m === 'EMI' && totalPaise < EMI_MIN_PAISE) {
      return `Available on orders above ${formatPaise(EMI_MIN_PAISE)}`;
    }
    if (m === 'COD' && totalPaise > COD_MAX_PAISE) {
      return `Not available above ${formatPaise(COD_MAX_PAISE)}`;
    }
    return null;
  }

  async function pay() {
    setError('');
    if (method === 'UPI' && upiId.trim() && upiState !== 'ok') {
      setError('Check your UPI ID before continuing');
      return;
    }
    setPlacing(true);
    try {
      const result = await api<CheckoutResult>('/api/orders/checkout', {
        body: {
          addressId,
          useCredits,
          deliveryMethod,
          isGift,
          ...(isGift && giftMessage ? { giftMessage } : {}),
          paymentMethod: method,
          ...(billingId && billingId !== addressId ? { billingAddressId: billingId } : {}),
        },
        auth: true,
      });

      // COD is confirmed server-side — straight to the confirmation page.
      if (!result.requiresPayment) {
        router.push(`/orders/${result.orderId}/confirmation`);
        return;
      }
      if (result.payment.provider === 'mock') {
        setMockOrder(result);
        return;
      }

      await loadRazorpayScript();
      if (!window.Razorpay) throw new Error('Could not load Razorpay');
      const rzp = new window.Razorpay({
        key: result.payment.keyId,
        amount: result.amountPaise,
        currency: 'INR',
        name: 'Clowe',
        description: `Order ${result.orderNumber}`,
        order_id: result.payment.providerOrderId,
        // Open Razorpay on the method the shopper already picked.
        method: method.toLowerCase(),
        prefill: upiId.trim() ? { vpa: upiId.trim() } : undefined,
        handler: (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          void api('/api/payments/verify', {
            body: {
              orderId: result.orderId,
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            },
            auth: true,
          }).then(() => router.push(`/orders/${result.orderId}/confirmation`));
        },
      });
      rzp.open();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Checkout failed');
    } finally {
      setPlacing(false);
    }
  }

  async function mockPay(outcome: 'success' | 'failure') {
    if (!mockOrder) return;
    setError('');
    try {
      await api('/api/payments/mock-pay', {
        body: { orderId: mockOrder.orderId, outcome },
        auth: true,
      });
      router.push(
        outcome === 'success'
          ? `/orders/${mockOrder.orderId}/confirmation`
          : `/account/orders/${mockOrder.orderId}`,
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Payment failed');
    }
  }

  // ---- Mock gateway screen ----
  if (mockOrder) {
    return (
      <main className="mx-auto max-w-md px-4 py-12">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 text-center">
          <p className="t-caption uppercase tracking-widest text-gray-400">
            Mock Payment Gateway (dev)
          </p>
          <h1 className="t-sub-heading mt-3 text-ink-900">Order {mockOrder.orderNumber}</h1>
          <p className="t-pdp-price mt-1 text-ink-900">{formatPaise(mockOrder.amountPaise)}</p>
          <p className="t-caption mt-2 text-gray-500">
            Paying by {PAYMENT_METHOD_META[mockOrder.method].label}. In production this is the
            Razorpay window.
          </p>
          {error && <p className="t-caption mt-3 text-red-600">{error}</p>}
          <div className="mt-6 space-y-2">
            <button
              onClick={() => void mockPay('success')}
              className="t-btn w-full rounded-lg bg-green-600 py-2.5 text-white hover:bg-green-700"
            >
              ✓ Simulate successful payment
            </button>
            <button
              onClick={() => void mockPay('failure')}
              className="t-btn w-full rounded-lg border border-red-300 py-2.5 text-red-600 hover:bg-red-50"
            >
              ✕ Simulate failed payment
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!cart) {
    return (
      <main className="mx-auto max-w-7xl animate-pulse px-4 py-6">
        <div className="h-8 w-40 rounded-lg bg-cream-100" />
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="h-96 rounded-2xl bg-cream-100" />
          <div className="h-80 rounded-2xl bg-cream-100" />
        </div>
      </main>
    );
  }

  if (lines.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <span className="text-5xl">🛍</span>
        <h1 className="t-page-title mt-4 text-ink-900">Nothing to pay for</h1>
        <Link
          href="/cart"
          className="t-btn mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-white hover:bg-ink-800"
        >
          Back to Cart
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-24 pt-4 lg:pb-8">
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/cart" className="hover:text-brand-600">
          Cart
        </Link>
        <span>›</span>
        <Link href="/checkout" className="hover:text-brand-600">
          Checkout
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Payment</span>
      </nav>

      <h1 className="t-page-title mt-2 text-ink-900">Checkout</h1>
      <CheckoutStepper current="payment" />

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          {/* 1 ─ Payment method */}
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="flex items-center gap-2.5 t-sub-heading text-ink-900">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-900 text-xs font-bold text-white">
                1
              </span>
              Choose a Payment Method
            </h2>

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
              {/* Method list */}
              <ul className="overflow-hidden rounded-xl border border-gray-200">
                {PAYMENT_METHODS.map((m) => {
                  const meta = PAYMENT_METHOD_META[m];
                  const blocked = unavailableReason(m);
                  const active = method === m;
                  return (
                    <li key={m}>
                      <label
                        className={`flex cursor-pointer items-center gap-3 border-b border-gray-100 px-4 py-3.5 last:border-b-0 transition ${
                          blocked
                            ? 'cursor-not-allowed opacity-50'
                            : active
                              ? 'bg-brand-50/50 ring-1 ring-inset ring-brand-600'
                              : 'hover:bg-cream-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="payment-method"
                          checked={active}
                          disabled={!!blocked}
                          onChange={() => setMethod(m)}
                          className="h-4 w-4 accent-brand-600"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="t-card-label block text-ink-900">{meta.label}</span>
                          <span className="t-caption block text-gray-500">
                            {blocked ?? meta.blurb}
                          </span>
                        </span>
                        {m === 'UPI' && !blocked && (
                          <span className="t-badge shrink-0 rounded bg-green-50 px-2 py-0.5 text-green-700">
                            Recommended
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>

              {/* Method detail */}
              <div className="rounded-xl border border-gray-200 p-4">
                {method === 'UPI' && (
                  <>
                    <p className="t-card-label text-ink-900">Pay using UPI</p>
                    <p className="t-caption mt-0.5 text-gray-500">
                      Enter your UPI ID — we hand it to the gateway so your app opens with the
                      amount pre-filled.
                    </p>

                    <label className="t-caption mt-4 block text-gray-600">
                      UPI ID
                      <span className="mt-1 flex gap-2">
                        <input
                          value={upiId}
                          onChange={(e) => {
                            setUpiId(e.target.value);
                            setUpiState('idle');
                          }}
                          placeholder="yourname@bank"
                          aria-label="UPI ID"
                          className="t-body min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-brand-600"
                        />
                        <button
                          onClick={() =>
                            setUpiState(UPI_ID_RE.test(upiId.trim()) ? 'ok' : 'bad')
                          }
                          className="t-btn shrink-0 rounded-lg bg-ink-900 px-5 text-white transition hover:bg-ink-800"
                        >
                          Check
                        </button>
                      </span>
                    </label>
                    {upiState === 'ok' && (
                      <p className="t-caption mt-1.5 font-semibold text-green-700">
                        ✓ That looks like a valid UPI ID
                      </p>
                    )}
                    {upiState === 'bad' && (
                      <p className="t-caption mt-1.5 font-semibold text-red-600">
                        That doesn&apos;t look like a UPI ID — the format is name@bank
                      </p>
                    )}

                    <p className="t-caption mt-4 font-bold text-gray-600">Popular UPI apps</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {UPI_APPS.map((app) => (
                        <span
                          key={app}
                          className="t-caption rounded-lg border border-gray-200 px-3 py-2 text-gray-600"
                        >
                          {app}
                        </span>
                      ))}
                    </div>
                    <p className="t-caption mt-3 rounded-lg bg-cream-50 px-3 py-2 text-gray-500">
                      You approve the payment inside your UPI app — Clowe never sees your PIN.
                    </p>
                  </>
                )}

                {method === 'CARD' && (
                  <>
                    <p className="t-card-label text-ink-900">Credit / Debit Card</p>
                    <p className="t-caption mt-0.5 text-gray-500">
                      Card details are entered on the gateway&apos;s secure page — they never reach
                      Clowe&apos;s servers.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {CARD_NETWORKS.map((n) => (
                        <span
                          key={n}
                          className="t-caption rounded-lg border border-gray-200 px-3 py-2 text-gray-600"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                    {savedMethods.filter((s) => s.kind === 'CARD').length > 0 && (
                      <div className="mt-4">
                        <p className="t-caption font-bold text-gray-600">Your saved cards</p>
                        <ul className="mt-2 space-y-2">
                          {savedMethods
                            .filter((s) => s.kind === 'CARD')
                            .map((s) => (
                              <li
                                key={s.id}
                                className="flex items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2"
                              >
                                <CardIcon className="h-4 w-4 text-gray-500" />
                                <span className="t-caption min-w-0 flex-1 text-ink-900">
                                  {s.brand} •••• {s.label}
                                </span>
                                {s.isDefault && (
                                  <span className="t-badge rounded border border-brand-200 px-1.5 py-0.5 text-brand-700">
                                    Default
                                  </span>
                                )}
                              </li>
                            ))}
                        </ul>
                        <p className="t-caption mt-2 text-gray-500">
                          Saved cards are a reminder only — you still confirm the card on the
                          gateway.
                        </p>
                      </div>
                    )}
                  </>
                )}

                {method === 'NETBANKING' && (
                  <>
                    <p className="t-card-label text-ink-900">Net Banking</p>
                    <p className="t-caption mt-0.5 text-gray-500">
                      Pick your bank — you finish the transfer on your bank&apos;s own page.
                    </p>
                    <select
                      value={bank}
                      onChange={(e) => setBank(e.target.value)}
                      aria-label="Bank"
                      className="t-body mt-3 w-full rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-brand-600"
                    >
                      {BANKS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                    <p className="t-caption mt-2 text-gray-500">
                      All major banks are supported on the gateway.
                    </p>
                  </>
                )}

                {method === 'WALLET' && (
                  <>
                    <p className="t-card-label text-ink-900">Wallets</p>
                    <p className="t-caption mt-0.5 text-gray-500">
                      Pay from your wallet balance.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {WALLETS.map((w) => (
                        <button
                          key={w}
                          onClick={() => setWallet(w)}
                          className={`t-caption rounded-lg border px-3 py-2 transition ${
                            wallet === w
                              ? 'border-brand-600 bg-brand-50 font-bold text-brand-700'
                              : 'border-gray-200 text-gray-600 hover:border-gray-300'
                          }`}
                        >
                          {w}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {method === 'EMI' && (
                  <>
                    <p className="t-card-label text-ink-900">EMI</p>
                    <p className="t-caption mt-0.5 text-gray-500">
                      Split {formatPaise(totalPaise)} across months on an eligible credit card. The
                      exact plans and interest come from your bank on the payment page.
                    </p>
                    <ul className="mt-3 space-y-2">
                      {[3, 6, 9, 12].map((months) => (
                        <li
                          key={months}
                          className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2"
                        >
                          <span className="t-caption text-gray-600">{months} months</span>
                          <span className="t-caption font-bold text-ink-900">
                            ≈ {formatPaise(Math.round(totalPaise / months))}/mo
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="t-caption mt-2 text-gray-400">
                      Indicative, before bank interest.
                    </p>
                  </>
                )}

                {method === 'COD' && (
                  <>
                    <p className="t-card-label text-ink-900">Cash on Delivery</p>
                    <p className="t-caption mt-0.5 text-gray-500">
                      Pay the courier when your order arrives. Your order is confirmed right away
                      and sellers start packing.
                    </p>
                    <p className="t-card-label mt-4 rounded-lg bg-cream-50 px-3 py-3 text-ink-900">
                      Keep {formatPaise(totalPaise)} ready at handover.
                    </p>
                    <p className="t-caption mt-2 text-gray-500">
                      Available on orders up to {formatPaise(COD_MAX_PAISE)}.
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Security strip */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-50/50 px-4 py-3">
              <p className="t-caption flex items-start gap-2 text-gray-600">
                <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                <span>
                  <span className="font-bold text-ink-900">100% Secure Payments</span>
                  <br />
                  Card and UPI details are entered on the gateway, never stored by Clowe.
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                {SECURITY_MARKS.map((mark) => (
                  <span
                    key={mark}
                    className="t-badge rounded border border-gray-200 bg-white px-2.5 py-1.5 text-gray-600"
                  >
                    {mark}
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* 2 ─ Billing address */}
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="flex items-center gap-2.5 t-sub-heading text-ink-900">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-900 text-xs font-bold text-white">
                2
              </span>
              Billing Address
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {addresses.map((a) => {
                const active = billingId === a.id;
                return (
                  <button
                    key={a.id}
                    onClick={() => setBillingId(a.id)}
                    className={`rounded-xl border p-3 text-left transition ${
                      active
                        ? 'border-brand-600 bg-brand-50/40 ring-1 ring-brand-600'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="t-card-label text-ink-900">
                        {ADDRESS_LABEL_TEXT[a.label]}
                      </span>
                      {a.isDefault && (
                        <span className="t-badge rounded bg-cream-200 px-1.5 py-0.5 uppercase text-gray-600">
                          Default
                        </span>
                      )}
                      <span
                        className={`ml-auto flex h-4 w-4 items-center justify-center rounded-full border ${
                          active ? 'border-brand-600 bg-brand-600' : 'border-gray-300'
                        }`}
                      >
                        {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                      </span>
                    </span>
                    <p className="t-caption mt-2 font-semibold text-ink-900">{a.name}</p>
                    <p className="t-caption mt-0.5 leading-relaxed text-gray-500">
                      {a.line1}
                      {a.line2 ? `, ${a.line2}` : ''}
                      <br />
                      {a.city}, {a.state} - {a.pincode}
                    </p>
                    <p className="t-caption mt-1 text-gray-500">+91 {a.phone}</p>
                  </button>
                );
              })}
              <Link
                href="/account/addresses"
                className="flex min-h-[8rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 p-3 text-gray-500 transition hover:border-brand-600 hover:text-brand-600"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full border border-current">
                  <PlusIcon />
                </span>
                <span className="t-caption font-semibold">Add New Billing Address</span>
              </Link>
            </div>
          </section>
        </div>

        {/* ── Order summary ─────────────────────────────────────────── */}
        <aside className="space-y-4 lg:sticky lg:top-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="t-sub-heading text-ink-900">Order Summary</h2>
              <Link href="/cart" className="t-caption font-semibold text-brand-600 hover:underline">
                Edit Cart
              </Link>
            </div>

            <ul className="mt-3 divide-y divide-gray-100">
              {lines.map((line) => (
                <li key={line.id} className="flex items-start gap-3 py-2.5">
                  {line.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={line.imageUrl}
                      alt=""
                      loading="lazy"
                      className="h-12 w-10 shrink-0 rounded bg-cream-100 object-cover"
                    />
                  ) : (
                    <div className="h-12 w-10 shrink-0 rounded bg-cream-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="t-caption line-clamp-2 font-semibold text-ink-900">
                      {line.title}
                    </p>
                    <p className="t-caption text-gray-500">
                      {line.label ? ` | ` : ''}Qty: {line.quantity}
                    </p>
                  </div>
                  <span className="t-caption shrink-0 font-bold text-ink-900">
                    {formatPaise(line.pricePaise * line.quantity)}
                  </span>
                </li>
              ))}
            </ul>

            <dl className="mt-3 space-y-2 border-t border-gray-200 pt-3">
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Subtotal ({itemCount} Items)</dt>
                <dd className="t-caption font-bold text-ink-900">{formatPaise(itemTotalPaise)}</dd>
              </div>
              {couponDiscountPaise > 0 && (
                <div className="flex justify-between">
                  <dt className="t-caption text-gray-600">
                    Coupon Discount{' '}
                    <span className="font-semibold text-brand-600">({cart.coupon?.code})</span>
                  </dt>
                  <dd className="t-caption font-bold text-green-600">
                    −{formatPaise(couponDiscountPaise)}
                  </dd>
                </div>
              )}
              {creditsDiscountPaise > 0 && (
                <div className="flex justify-between">
                  <dt className="t-caption text-gray-600">Clowe Credits ({creditsUsable} 🪙)</dt>
                  <dd className="t-caption font-bold text-green-600">
                    −{formatPaise(creditsDiscountPaise)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">
                  Shipping Charges
                  {chosenDelivery && (
                    <span className="t-caption block text-gray-400">({chosenDelivery.label})</span>
                  )}
                </dt>
                <dd
                  className={`t-caption font-bold ${
                    shippingPaise === 0 ? 'text-green-600' : 'text-ink-900'
                  }`}
                >
                  {shippingPaise === 0 ? 'FREE' : formatPaise(shippingPaise)}
                </dd>
              </div>
            </dl>

            <div className="mt-3 flex items-baseline justify-between border-t border-gray-200 pt-3">
              <span className="t-card-label text-ink-900">
                Total Amount
                <span className="t-caption block font-normal text-gray-400">
                  (Inclusive of all taxes)
                </span>
              </span>
              <span className="t-cart-subtotal text-ink-900">{formatPaise(totalPaise)}</span>
            </div>

            {savingsPaise > 0 && (
              <p className="t-caption mt-3 rounded-lg bg-green-50 px-3 py-2 text-center font-semibold text-green-700">
                You are saving {formatPaise(savingsPaise)} on this order!
              </p>
            )}

            {shipTo && (
              <div className="mt-3 flex items-start gap-2.5 border-t border-gray-100 pt-3">
                <TruckIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                <div className="min-w-0">
                  <p className="t-caption truncate text-gray-600">
                    Delivering to: {shipTo.line1}, {shipTo.city}
                  </p>
                  {chosenDelivery && (
                    <p className="t-caption text-gray-500">
                      Estimated Delivery: {fmtShort(chosenDelivery.etaFrom)} –{' '}
                      {fmtShort(chosenDelivery.etaTo)}
                    </p>
                  )}
                </div>
              </div>
            )}

            <button
              onClick={() => void pay()}
              disabled={placing}
              className="t-btn mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 py-3.5 text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              <LockIcon className="h-4 w-4" />
              {placing
                ? 'Please wait…'
                : method === 'COD'
                  ? `Place Order · ${formatPaise(totalPaise)}`
                  : `Pay ${formatPaise(totalPaise)} Securely`}
            </button>
            <p className="t-caption mt-2 flex items-center justify-center gap-1.5 text-center text-gray-400">
              <ShieldCheckIcon className="h-3.5 w-3.5" />
              {method === 'COD'
                ? 'You pay the courier on delivery'
                : 'You are taken to the gateway to authorise the payment'}
            </p>
            <Link
              href="/checkout"
              className="t-caption mt-2 block text-center text-gray-500 hover:text-brand-600"
            >
              ‹ Back to address &amp; delivery
            </Link>
          </div>
        </aside>
      </div>

      {/* Trust strip */}
      <section className="mt-6 grid gap-3 rounded-2xl border border-gray-100 bg-white p-5 sm:grid-cols-2 lg:grid-cols-5">
        {TRUST_STRIP.map(({ Icon, title, text }) => (
          <div key={title} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
            <div className="min-w-0">
              <p className="t-caption font-bold text-ink-900">{title}</p>
              <p className="t-caption text-gray-500">{text}</p>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}

export default function PaymentPage() {
  return (
    <Suspense>
      <PaymentPageInner />
    </Suspense>
  );
}
