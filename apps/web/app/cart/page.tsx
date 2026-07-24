'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CartView } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';

export default function CartPage() {
  const [cart, setCart] = useState<CartView | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [error, setError] = useState('');
  const [busyLine, setBusyLine] = useState<string | null>(null);

  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    api<CartView>('/api/cart', { auth: true })
      .then(setCart)
      .catch(() => setError('Could not load your cart'));
  }, []);

  async function setQuantity(lineId: string, quantity: number) {
    setError('');
    setBusyLine(lineId);
    try {
      const updated =
        quantity === 0
          ? await api<CartView>(`/api/cart/items/${lineId}`, { method: 'DELETE', auth: true })
          : await api<CartView>(`/api/cart/items/${lineId}`, {
              method: 'PATCH',
              body: { quantity },
              auth: true,
            });
      setCart(updated);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusyLine(null);
    }
  }

  if (loggedOut) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Your cart</p>
        <p className="mt-2 text-sm text-gray-600">
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Login
          </Link>{' '}
          to see your cart.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-bold">Your Cart</h1>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {!cart && !error && <p className="mt-6 text-sm text-gray-500">Loading…</p>}

      {cart && cart.lines.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          Your cart is empty.{' '}
          <Link href="/products" className="font-semibold text-brand-600 hover:underline">
            Start shopping →
          </Link>
        </p>
      )}

      {cart && cart.lines.length > 0 && (
        <div className="mt-4 flex flex-col gap-6 lg:flex-row">
          <div className="flex-1 space-y-3">
            {cart.lines.map((line) => (
              <div key={line.id} className="flex gap-4 rounded-xl border border-gray-200 bg-white p-3">
                <Link href={`/products/${line.slug}`} className="shrink-0">
                  {line.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={line.imageUrl} alt="" className="h-24 w-20 rounded-lg object-cover" />
                  ) : (
                    <div className="h-24 w-20 rounded-lg bg-gray-100" />
                  )}
                </Link>
                <div className="min-w-0 flex-1">
                  <Link href={`/products/${line.slug}`} className="block truncate text-sm font-semibold hover:text-brand-600">
                    {line.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {line.brand ?? ''} · {line.color} / {line.size}
                  </p>
                  <p className="mt-1 text-sm font-bold">
                    {formatPaise(line.pricePaise)}
                    {line.mrpPaise && line.mrpPaise > line.pricePaise && (
                      <span className="ml-2 text-xs font-normal text-gray-400 line-through">
                        {formatPaise(line.mrpPaise)}
                      </span>
                    )}
                  </p>
                  {line.stock < line.quantity && (
                    <p className="mt-1 text-xs font-medium text-red-600">
                      Only {line.stock} left — reduce quantity
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-3">
                    <div className="flex items-center rounded-lg border border-gray-300">
                      <button
                        onClick={() => void setQuantity(line.id, line.quantity - 1)}
                        disabled={busyLine === line.id}
                        className="px-3 py-1 text-sm hover:bg-gray-50"
                        aria-label="Decrease quantity"
                      >
                        −
                      </button>
                      <span className="min-w-8 text-center text-sm font-medium">{line.quantity}</span>
                      <button
                        onClick={() => void setQuantity(line.id, Math.min(line.quantity + 1, 10))}
                        disabled={busyLine === line.id || line.quantity >= Math.min(line.stock, 10)}
                        className="px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
                        aria-label="Increase quantity"
                      >
                        +
                      </button>
                    </div>
                    <button
                      onClick={() => void setQuantity(line.id, 0)}
                      disabled={busyLine === line.id}
                      className="text-xs text-red-500 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Summary */}
          <aside className="h-fit w-full rounded-xl border border-gray-200 bg-white p-4 lg:w-72">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Price details</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-600">Subtotal ({cart.lines.length} items)</dt>
                <dd className="font-medium">{formatPaise(cart.subtotalPaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-600">Shipping</dt>
                <dd className={cart.shippingPaise === 0 ? 'font-medium text-green-600' : 'font-medium'}>
                  {cart.shippingPaise === 0 ? 'FREE' : formatPaise(cart.shippingPaise)}
                </dd>
              </div>
              {cart.shippingPaise > 0 && (
                <p className="text-xs text-gray-500">
                  Add {formatPaise(cart.freeShippingThresholdPaise - cart.subtotalPaise)} more for free shipping
                </p>
              )}
              <div className="flex justify-between border-t border-gray-200 pt-2 text-base">
                <dt className="font-bold">Total</dt>
                <dd className="font-bold">{formatPaise(cart.totalPaise)}</dd>
              </div>
            </dl>
            <Link
              href="/checkout"
              className="mt-4 block rounded-lg bg-brand-600 py-2.5 text-center text-sm font-semibold text-white hover:bg-brand-700"
            >
              Proceed to Checkout →
            </Link>
          </aside>
        </div>
      )}
    </main>
  );
}
