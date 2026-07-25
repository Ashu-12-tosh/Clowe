'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  addressUpsertSchema,
  type AddressInfo,
  type CartView,
  type CheckoutResult,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

export default function CheckoutPage() {
  const router = useRouter();
  const [cart, setCart] = useState<CartView | null>(null);
  const [addresses, setAddresses] = useState<AddressInfo[] | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [error, setError] = useState('');
  const [placing, setPlacing] = useState(false);
  // After checkout with the mock provider: show the fake gateway step.
  const [mockOrder, setMockOrder] = useState<CheckoutResult | null>(null);

  useEffect(() => {
    if (!getStoredUser()) {
      router.replace('/login');
      return;
    }
    api<CartView>('/api/cart', { auth: true }).then(setCart).catch(() => {});
    api<AddressInfo[]>('/api/addresses', { auth: true })
      .then((list) => {
        setAddresses(list);
        const def = list.find((a) => a.isDefault) ?? list[0];
        if (def) setSelectedAddress(def.id);
        if (list.length === 0) setShowAddressForm(true);
      })
      .catch(() => setAddresses([]));
  }, [router]);

  async function saveAddress(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const raw = Object.fromEntries(
      [...new FormData(e.currentTarget).entries()].filter(([, v]) => String(v).trim() !== ''),
    );
    const parsed = addressUpsertSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join('.')}: ${issue.message}`);
      return;
    }
    try {
      const created = await api<AddressInfo>('/api/addresses', { body: parsed.data, auth: true });
      setAddresses((prev) => [created, ...(prev ?? [])]);
      setSelectedAddress(created.id);
      setShowAddressForm(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save address');
    }
  }

  async function placeOrder() {
    setError('');
    setPlacing(true);
    try {
      const result = await api<CheckoutResult>('/api/orders/checkout', {
        body: { addressId: selectedAddress },
        auth: true,
      });

      if (result.payment.provider === 'mock') {
        setMockOrder(result); // show the fake gateway step
        return;
      }

      // Razorpay checkout.js flow.
      await loadRazorpayScript();
      if (!window.Razorpay) throw new Error('Could not load Razorpay');
      const rzp = new window.Razorpay({
        key: result.payment.keyId,
        amount: result.amountPaise,
        currency: 'INR',
        name: 'Clowe',
        description: `Order ${result.orderNumber}`,
        order_id: result.payment.providerOrderId,
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
          }).then(() => router.push(`/orders/${result.orderId}?placed=1`));
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
      router.push(`/orders/${mockOrder.orderId}${outcome === 'success' ? '?placed=1' : ''}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Payment failed');
    }
  }

  // ---- Mock gateway screen ----
  if (mockOrder) {
    return (
      <main className="mx-auto max-w-md px-4 py-12">
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Mock Payment Gateway (dev)
          </p>
          <h1 className="mt-3 text-xl font-bold">Order {mockOrder.orderNumber}</h1>
          <p className="mt-1 text-3xl font-bold text-brand-900">
            {formatPaise(mockOrder.amountPaise)}
          </p>
          <p className="mt-2 text-xs text-gray-500">
            In production this is the Razorpay window (UPI / cards / netbanking).
          </p>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <div className="mt-6 space-y-2">
            <button
              onClick={() => void mockPay('success')}
              className="w-full rounded-lg bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-700"
            >
              ✓ Simulate successful payment
            </button>
            <button
              onClick={() => void mockPay('failure')}
              className="w-full rounded-lg border border-red-300 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-50"
            >
              ✕ Simulate failed payment
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-bold">Checkout</h1>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {cart && cart.lines.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          Your cart is empty.{' '}
          <Link href="/products" className="font-semibold text-brand-600 hover:underline">
            Shop first →
          </Link>
        </p>
      )}

      {cart && cart.lines.length > 0 && (
        <div className="mt-4 flex flex-col gap-6 lg:flex-row">
          <div className="flex-1 space-y-5">
            {/* -------- Address -------- */}
            <section className="rounded-xl border border-gray-200 bg-white p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
                1. Delivery address
              </h2>

              {addresses && addresses.length > 0 && (
                <div className="mt-3 space-y-2">
                  {addresses.map((a) => (
                    <label
                      key={a.id}
                      className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${
                        selectedAddress === a.id ? 'border-brand-600 bg-brand-100/40' : 'border-gray-200'
                      }`}
                    >
                      <input
                        type="radio"
                        name="address"
                        checked={selectedAddress === a.id}
                        onChange={() => setSelectedAddress(a.id)}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-semibold">{a.name}</span>{' '}
                        <span className="text-gray-500">· +91 {a.phone}</span>
                        {a.isDefault && (
                          <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs">default</span>
                        )}
                        <br />
                        <span className="text-gray-600">
                          {a.line1}
                          {a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.state} — {a.pincode}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {!showAddressForm ? (
                <button
                  onClick={() => setShowAddressForm(true)}
                  className="mt-3 text-sm font-semibold text-brand-600 hover:underline"
                >
                  + Add new address
                </button>
              ) : (
                <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={(e) => void saveAddress(e)}>
                  <input name="name" placeholder="Full name *" className={field} required />
                  <input name="phone" placeholder="10-digit phone *" className={field} required maxLength={10} />
                  <input name="line1" placeholder="House no, street *" className={`sm:col-span-2 ${field}`} required />
                  <input name="line2" placeholder="Area, locality" className={`sm:col-span-2 ${field}`} />
                  <input name="landmark" placeholder="Landmark" className={field} />
                  <input name="pincode" placeholder="Pincode *" className={field} required maxLength={6} />
                  <input name="city" placeholder="City *" className={field} required />
                  <input name="state" placeholder="State *" className={field} required />
                  <div className="flex gap-2 sm:col-span-2">
                    <button className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                      Save address
                    </button>
                    {addresses && addresses.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowAddressForm(false)}
                        className="rounded-lg border border-gray-300 px-5 py-2 text-sm text-gray-600"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </form>
              )}
            </section>

            {/* -------- Items -------- */}
            <section className="rounded-xl border border-gray-200 bg-white p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
                2. Order items
              </h2>
              <ul className="mt-3 space-y-2">
                {cart.lines.map((line) => (
                  <li key={line.id} className="flex items-center gap-3 text-sm">
                    {line.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={line.imageUrl} alt="" className="h-12 w-10 rounded object-cover" />
                    ) : (
                      <div className="h-12 w-10 rounded bg-gray-100" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {line.title}{' '}
                      <span className="text-gray-500">
                        · {line.color}/{line.size} × {line.quantity}
                      </span>
                    </span>
                    <span className="font-medium">{formatPaise(line.pricePaise * line.quantity)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* -------- Summary + pay -------- */}
          <aside className="h-fit w-full rounded-xl border border-gray-200 bg-white p-4 lg:w-72">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Payment</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-600">Subtotal</dt>
                <dd>{formatPaise(cart.subtotalPaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-600">Shipping</dt>
                <dd>{cart.shippingPaise === 0 ? 'FREE' : formatPaise(cart.shippingPaise)}</dd>
              </div>
              <div className="flex justify-between border-t border-gray-200 pt-2 text-base">
                <dt className="font-bold">To pay</dt>
                <dd className="font-bold">{formatPaise(cart.totalPaise)}</dd>
              </div>
            </dl>
            <button
              onClick={() => void placeOrder()}
              disabled={placing || !selectedAddress}
              className="mt-4 w-full rounded-lg bg-ink-900 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
            >
              {placing ? 'Placing order…' : 'Place Order'}
            </button>
            <p className="mt-2 text-center text-xs text-gray-400">
              🔒 100% Secure Payments · Razorpay (mock in dev)
            </p>
          </aside>
        </div>
      )}
    </main>
  );
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
