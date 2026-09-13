'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { CartLine, CartView } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { discountPercent, formatPaise } from '@/lib/format';
import { BADGES_EVENT } from '@/components/Header';
import CartSuggestions from '@/components/cart/CartSuggestions';
import CouponPanel from '@/components/cart/CouponPanel';
import {
  BoxIcon,
  ChevronIcon,
  HeadsetIcon,
  HeartIcon,
  InfoIcon,
  LockIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TrashIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

const MAX_QTY = 10;

const WHY_SHOP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns on eligible items' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Customer Support', text: 'We are here for you' },
];

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns on eligible items' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

const PAYMENT_METHODS = ['VISA', 'Mastercard', 'RuPay', 'UPI', 'Paytm'];

/** Header/summary counts are in items, matching the "(5 Items)" in the title. */
function itemCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

export default function CartPage() {
  const [cart, setCart] = useState<CartView | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const [error, setError] = useState('');
  const [busyLines, setBusyLines] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showDiscountBreakup, setShowDiscountBreakup] = useState(false);

  /** Cart writes all return the whole cart — swap it in and refresh the badge. */
  const applyCart = useCallback((next: CartView) => {
    setCart(next);
    window.dispatchEvent(new Event(BADGES_EVENT));
  }, []);

  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    api<CartView>('/api/cart', { auth: true })
      .then(setCart)
      .catch(() => setError('Could not load your cart'));
  }, []);

  function setLineBusy(lineId: string, busy: boolean) {
    setBusyLines((prev) => {
      const next = new Set(prev);
      if (busy) next.add(lineId);
      else next.delete(lineId);
      return next;
    });
  }

  /** Run a cart write for one line, showing its spinner state and any error. */
  async function lineAction(lineId: string, run: () => Promise<CartView>) {
    setError('');
    setLineBusy(lineId, true);
    try {
      applyCart(await run());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      // Re-sync, so an optimistic tick that failed server-side snaps back.
      api<CartView>('/api/cart', { auth: true }).then(setCart).catch(() => {});
    } finally {
      setLineBusy(lineId, false);
    }
  }

  const setQuantity = (line: CartLine, quantity: number) =>
    lineAction(line.id, () =>
      quantity === 0
        ? api<CartView>(`/api/cart/items/${line.id}`, { method: 'DELETE', auth: true })
        : api<CartView>(`/api/cart/items/${line.id}`, {
            method: 'PATCH',
            body: { quantity },
            auth: true,
          }),
    );

  function toggleLine(line: CartLine) {
    // Optimistic: the tick is the most-used control, so it flips instantly.
    setCart((prev) =>
      prev
        ? { ...prev, lines: prev.lines.map((l) => (l.id === line.id ? { ...l, selected: !l.selected } : l)) }
        : prev,
    );
    void lineAction(line.id, () =>
      api<CartView>(`/api/cart/items/${line.id}`, {
        method: 'PATCH',
        body: { selected: !line.selected },
        auth: true,
      }),
    );
  }

  const moveToWishlist = (line: CartLine) =>
    lineAction(line.id, () =>
      api<CartView>(`/api/cart/items/${line.id}/move-to-wishlist`, { method: 'POST', auth: true }),
    );

  /** Bulk writes (select all / delete selected / clear) share one busy flag. */
  async function bulkAction(run: () => Promise<CartView>) {
    setError('');
    setBulkBusy(true);
    try {
      applyCart(await run());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBulkBusy(false);
    }
  }

  const lines = useMemo(() => cart?.lines ?? [], [cart]);
  const selectedLines = useMemo(() => lines.filter((l) => l.selected), [lines]);
  const allSelected = lines.length > 0 && selectedLines.length === lines.length;
  const shortOfFreeShipping = cart
    ? Math.max(0, cart.freeShippingThresholdPaise - cart.subtotalPaise)
    : 0;
  const freeShippingProgress = cart
    ? Math.min(100, Math.round((cart.subtotalPaise / cart.freeShippingThresholdPaise) * 100))
    : 0;

  // --- Empty / logged-out states -------------------------------------------

  if (loggedOut) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <span className="text-5xl">🛒</span>
        <h1 className="mt-4 font-display text-2xl font-bold text-ink-900">Your cart is waiting</h1>
        <p className="mt-2 text-sm text-gray-500">Login to see the items you added.</p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-sm font-bold uppercase tracking-wide text-white transition hover:bg-ink-800"
        >
          Login
        </Link>
      </main>
    );
  }

  if (!cart && !error) {
    return (
      <main className="mx-auto max-w-7xl animate-pulse px-4 py-6">
        <div className="h-8 w-48 rounded-lg bg-cream-100" />
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="h-96 rounded-2xl bg-cream-100" />
          <div className="h-72 rounded-2xl bg-cream-100" />
        </div>
      </main>
    );
  }

  if (cart && lines.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <span className="text-5xl">🛍</span>
        <h1 className="mt-4 font-display text-2xl font-bold text-ink-900">Your cart is empty</h1>
        <p className="mt-2 text-sm text-gray-500">
          Add something you love — free delivery on orders above{' '}
          {formatPaise(cart.freeShippingThresholdPaise)}.
        </p>
        <Link
          href="/products"
          className="mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-sm font-bold uppercase tracking-wide text-white transition hover:bg-ink-800"
        >
          Start Shopping
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-24 pt-4 lg:pb-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Cart</span>
      </nav>

      {/* Title row */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="t-page-title text-ink-900">
          My Cart{' '}
          <span className="text-base font-medium text-gray-500">({itemCount(lines)} Items)</span>
        </h1>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-sm font-medium text-gray-600 sm:flex">
            <ShieldCheckIcon className="h-4 w-4 text-green-600" />
            Secure Checkout
          </span>
          <button
            onClick={() => {
              if (confirm('Remove all items from your cart?')) {
                void bulkAction(() => api<CartView>('/api/cart', { method: 'DELETE', auth: true }));
              }
            }}
            disabled={bulkBusy}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50"
          >
            <TrashIcon className="h-3.5 w-3.5" />
            Clear Cart
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ── Left: line items ───────────────────────────────────────────── */}
        <div>
          <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
            {/* Column header (desktop) */}
            <div className="hidden items-center gap-3 border-b border-gray-100 bg-cream-50 px-4 py-3 lg:flex">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    void bulkAction(() =>
                      api<CartView>('/api/cart/select-all', {
                        method: 'POST',
                        body: { selected: !allSelected },
                        auth: true,
                      }),
                    )
                  }
                  disabled={bulkBusy}
                  className="h-4 w-4 accent-brand-600"
                />
                <span className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  Select All
                </span>
              </label>
              <span className="w-20" aria-hidden />
              <div className="grid flex-1 grid-cols-[minmax(0,1fr)_110px_140px_110px_76px] gap-4 text-xs font-bold uppercase tracking-wide text-gray-500">
                <span>Product</span>
                <span>Price</span>
                <span>Quantity</span>
                <span>Total</span>
                <span className="text-center">Action</span>
              </div>
            </div>

            {/* Select-all (mobile) */}
            <label className="flex cursor-pointer items-center gap-2 border-b border-gray-100 bg-cream-50 px-3 py-2.5 lg:hidden">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() =>
                  void bulkAction(() =>
                    api<CartView>('/api/cart/select-all', {
                      method: 'POST',
                      body: { selected: !allSelected },
                      auth: true,
                    }),
                  )
                }
                disabled={bulkBusy}
                className="h-4 w-4 accent-brand-600"
              />
              <span className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Select All ({selectedLines.length}/{lines.length})
              </span>
            </label>

            <ul className="divide-y divide-gray-100">
              {lines.map((line) => {
                const off = discountPercent(line.pricePaise, line.mrpPaise);
                const busy = busyLines.has(line.id);
                const outOfStock = line.stock === 0;
                const shortStock = !outOfStock && line.stock < line.quantity;
                const tryOn = line.tryOnEligible;
                return (
                  <li
                    key={line.id}
                    className={`flex items-start gap-3 px-3 py-4 transition sm:px-4 ${
                      busy ? 'opacity-60' : ''
                    } ${line.selected ? '' : 'bg-gray-50/60'}`}
                  >
                    <input
                      type="checkbox"
                      checked={line.selected}
                      onChange={() => toggleLine(line)}
                      disabled={busy || outOfStock}
                      aria-label={`Select ${line.title}`}
                      className="mt-1 h-4 w-4 shrink-0 accent-brand-600"
                    />

                    <Link href={`/products/${line.slug}`} className="shrink-0">
                      {line.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={line.imageUrl}
                          alt=""
                          loading="lazy"
                          className="h-20 w-16 rounded-lg bg-cream-100 object-cover sm:h-24 sm:w-20"
                        />
                      ) : (
                        <div className="h-20 w-16 rounded-lg bg-cream-100 sm:h-24 sm:w-20" />
                      )}
                    </Link>

                    <div className="grid min-w-0 flex-1 gap-2 lg:grid-cols-[minmax(0,1fr)_110px_140px_110px_76px] lg:items-center lg:gap-4">
                      {/* Product */}
                      <div className="min-w-0">
                        <Link
                          href={`/products/${line.slug}`}
                          className="line-clamp-2 text-sm font-semibold text-ink-900 hover:text-brand-600"
                        >
                          {line.title}
                        </Link>
                        {line.label && (
                          <p className="mt-1 text-xs text-gray-500">
                            <span className="font-medium text-gray-700">{line.label}</span>
                          </p>
                        )}
                        {tryOn && (
                          <span className="mt-1.5 inline-flex items-center gap-1 rounded border border-brand-100 bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">
                            ✨ AI Try-On
                          </span>
                        )}
                      </div>

                      {/* Price */}
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-sm font-bold text-ink-900">
                          {formatPaise(line.pricePaise)}
                        </span>
                        {line.mrpPaise && off !== null && (
                          <>
                            <span className="text-xs text-gray-400 line-through">
                              {formatPaise(line.mrpPaise)}
                            </span>
                            <span className="text-xs font-bold text-brand-600">{off}% OFF</span>
                          </>
                        )}
                      </div>

                      {/* Quantity */}
                      <div>
                        <div className="inline-flex items-center rounded-lg border border-gray-300">
                          <button
                            onClick={() => void setQuantity(line, Math.max(1, line.quantity - 1))}
                            disabled={busy || line.quantity <= 1}
                            className="px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-30"
                            aria-label="Decrease quantity"
                          >
                            −
                          </button>
                          <span className="min-w-9 text-center text-sm font-bold text-ink-900">
                            {line.quantity}
                          </span>
                          <button
                            onClick={() => void setQuantity(line, line.quantity + 1)}
                            disabled={busy || line.quantity >= Math.min(line.stock, MAX_QTY)}
                            className="px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-30"
                            aria-label="Increase quantity"
                          >
                            +
                          </button>
                        </div>
                      </div>

                      {/* Line total + stock */}
                      <div>
                        <p className="text-sm font-bold text-ink-900">
                          {formatPaise(line.pricePaise * line.quantity)}
                        </p>
                        {outOfStock ? (
                          <p className="mt-0.5 text-xs font-semibold text-red-600">Out of stock</p>
                        ) : shortStock ? (
                          <p className="mt-0.5 text-xs font-semibold text-orange-600">
                            Only {line.stock} left
                          </p>
                        ) : (
                          <p className="mt-0.5 text-xs font-medium text-green-600">In Stock</p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 lg:justify-center">
                        <button
                          onClick={() => void moveToWishlist(line)}
                          disabled={busy}
                          title="Move to wishlist"
                          aria-label={`Move ${line.title} to wishlist`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition hover:border-brand-600 hover:text-brand-600 disabled:opacity-40"
                        >
                          <HeartIcon />
                        </button>
                        <button
                          onClick={() => void setQuantity(line, 0)}
                          disabled={busy}
                          title="Remove from cart"
                          aria-label={`Remove ${line.title}`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-40"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Card footer: bulk delete + free-delivery meter */}
            <div className="flex flex-col gap-4 border-t border-gray-100 bg-cream-50 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <button
                onClick={() =>
                  void bulkAction(() =>
                    api<CartView>('/api/cart/items/bulk-delete', {
                      method: 'POST',
                      body: { ids: selectedLines.map((l) => l.id) },
                      auth: true,
                    }),
                  )
                }
                disabled={bulkBusy || selectedLines.length === 0}
                className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 transition hover:border-red-300 hover:text-red-600 disabled:opacity-40"
              >
                <TrashIcon className="h-3.5 w-3.5" />
                Delete Selected
              </button>

              <div className="lg:max-w-md lg:flex-1">
                {shortOfFreeShipping === 0 ? (
                  <p className="flex items-center gap-2 text-xs font-semibold text-green-700">
                    <ShieldCheckIcon className="h-4 w-4 shrink-0" />
                    Yay! You get FREE delivery on this order.
                  </p>
                ) : (
                  <p className="text-xs font-medium text-gray-600">
                    Add items worth{' '}
                    <span className="font-bold text-ink-900">
                      {formatPaise(shortOfFreeShipping)}
                    </span>{' '}
                    to get FREE delivery.
                  </p>
                )}
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200">
                  <div
                    className="h-full rounded-full bg-brand-600 transition-all"
                    style={{ width: `${freeShippingProgress}%` }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-gray-400">
                  <span>₹0</span>
                  <span>{formatPaise(cart!.freeShippingThresholdPaise)}</span>
                </div>
              </div>
            </div>
          </div>

          <CartSuggestions
            excludeIds={lines.map((l) => l.productId)}
            categorySlug={lines[0]?.rootCategorySlug ?? null}
          />
        </div>

        {/* ── Right: order summary ───────────────────────────────────────── */}
        <aside className="space-y-4 lg:sticky lg:top-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-base font-bold text-ink-900">Order Summary</h2>

            <dl className="mt-3 space-y-2.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-600">
                  Subtotal ({itemCount(selectedLines)} Item{itemCount(selectedLines) === 1 ? '' : 's'})
                </dt>
                <dd className="font-semibold text-ink-900">{formatPaise(cart!.mrpSubtotalPaise)}</dd>
              </div>

              {cart!.discountPaise > 0 && (
                <div>
                  <div className="flex justify-between">
                    <dt className="flex items-center gap-1 text-gray-600">
                      Discount
                      <button
                        onClick={() => setShowDiscountBreakup((v) => !v)}
                        aria-label="Toggle discount breakup"
                        className="text-gray-400 hover:text-brand-600"
                      >
                        <ChevronIcon className="h-3.5 w-3.5" open={showDiscountBreakup} />
                      </button>
                    </dt>
                    <dd className="font-semibold text-green-600">
                      −{formatPaise(cart!.discountPaise)}
                    </dd>
                  </div>
                  {showDiscountBreakup && (
                    <ul className="mt-1.5 space-y-1 rounded-lg bg-cream-50 px-3 py-2 text-xs text-gray-500">
                      {selectedLines
                        .filter((l) => l.mrpPaise && l.mrpPaise > l.pricePaise)
                        .map((l) => (
                          <li key={l.id} className="flex justify-between gap-3">
                            <span className="truncate">{l.title}</span>
                            <span className="shrink-0 font-medium text-green-600">
                              −{formatPaise((l.mrpPaise! - l.pricePaise) * l.quantity)}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="flex justify-between">
                <dt className="flex items-center gap-1 text-gray-600">
                  Shipping
                  <span title={`Free above ${formatPaise(cart!.freeShippingThresholdPaise)}`}>
                    <InfoIcon className="h-3.5 w-3.5 text-gray-400" />
                  </span>
                </dt>
                <dd
                  className={
                    cart!.shippingPaise === 0
                      ? 'font-bold text-green-600'
                      : 'font-semibold text-ink-900'
                  }
                >
                  {cart!.shippingPaise === 0 ? 'FREE' : formatPaise(cart!.shippingPaise)}
                </dd>
              </div>

              {cart!.promotions.map((promo) => (
                <div key={promo.id} className="flex justify-between">
                  <dt className="text-gray-600">
                    {promo.name}
                    <span className="ml-1 text-[11px] text-gray-400">
                      {promo.code ? `(${promo.code})` : '(seller offer)'}
                    </span>
                  </dt>
                  <dd className="font-semibold text-green-600">
                    −{formatPaise(promo.discountPaise)}
                  </dd>
                </div>
              ))}

              {cart!.couponDiscountPaise > 0 && (
                <div className="flex justify-between">
                  <dt className="text-gray-600">Coupon Discount</dt>
                  <dd className="font-semibold text-green-600">
                    −{formatPaise(cart!.couponDiscountPaise)}
                  </dd>
                </div>
              )}
            </dl>

            <div className="mt-3">
              <CouponPanel
                applied={cart!.coupon}
                subtotalPaise={cart!.subtotalPaise}
                onCartChange={applyCart}
              />
            </div>

            <div className="mt-3 flex items-baseline justify-between border-t border-gray-200 pt-3">
              <span className="font-bold text-ink-900">
                Total{' '}
                <span className="text-[11px] font-normal text-gray-400">
                  (Inclusive of all taxes)
                </span>
              </span>
              <span className="t-cart-subtotal text-ink-900">{formatPaise(cart!.totalPaise)}</span>
            </div>

            {cart!.savingsPaise > 0 && (
              <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-center text-xs font-semibold text-green-700">
                You are saving {formatPaise(cart!.savingsPaise)} on this order
              </p>
            )}

            {selectedLines.length === 0 ? (
              <p className="mt-3 rounded-lg bg-cream-100 px-3 py-3 text-center text-xs font-medium text-gray-500">
                Select at least one item to continue
              </p>
            ) : (
              <div className="mt-3 space-y-2.5">
                <Link
                  href="/checkout"
                  className="flex items-center justify-center gap-2 rounded-lg bg-brand-600 py-3 text-sm font-bold text-white transition hover:bg-brand-700"
                >
                  <LockIcon className="h-4 w-4" />
                  Proceed to Checkout
                </Link>
              </div>
            )}
          </div>

          {/* We accept */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">We Accept</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {PAYMENT_METHODS.map((method) => (
                <span
                  key={method}
                  className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-bold tracking-wide text-gray-600"
                >
                  {method}
                </span>
              ))}
              <span className="rounded-md border border-gray-200 bg-cream-50 px-2.5 py-1.5 text-[11px] font-bold text-gray-500">
                +5
              </span>
            </div>
          </div>

          {/* Payment safety */}
          <div className="flex items-start gap-3 rounded-2xl border border-gray-100 bg-white p-4">
            <ShieldCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
            <div>
              <p className="text-sm font-bold text-ink-900">Safe &amp; Secure Payments</p>
              <p className="mt-0.5 text-xs text-gray-500">
                Your payment information is 100% secure
              </p>
            </div>
          </div>

          {/* Why shop */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">Why shop at CLOWE?</p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {WHY_SHOP.map(({ Icon, title, text }) => (
                <div key={title} className="flex items-start gap-2">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-ink-900">{title}</p>
                    <p className="text-[11px] text-gray-500">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {/* Bottom trust strip */}
      <section className="mt-6 grid gap-3 rounded-2xl border border-gray-100 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5">
        {TRUST_STRIP.map(({ Icon, title, text }) => (
          <div key={title} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-ink-900">{title}</p>
              <p className="text-[11px] text-gray-500">{text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Sticky mobile checkout bar */}
      {selectedLines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-gray-200 bg-white px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] lg:hidden">
          <div>
            <p className="t-cart-price leading-none text-ink-900">{formatPaise(cart!.totalPaise)}</p>
            <p className="mt-0.5 text-[11px] text-gray-500">
              {itemCount(selectedLines)} item{itemCount(selectedLines) === 1 ? '' : 's'} selected
            </p>
          </div>
          <Link
            href="/checkout"
            className="rounded-lg bg-brand-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-700"
          >
            Proceed to Checkout
          </Link>
        </div>
      )}
    </main>
  );
}
