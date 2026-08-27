'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  DeliveryMethod,
  OrderDetailItem,
  OrderDetailView,
  ProductListItem,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BADGES_EVENT } from '@/components/Header';
import { SUPPORT_CHAT_EVENT } from '@/components/SupportChat';
import { Scroller } from '@/components/home/HomeBits';
import ProductCard from '@/components/ProductCard';
import { ReturnModal, ReturnTimeline } from '@/components/orders/ReturnBits';
import ReviewModal from '@/components/orders/ReviewModal';
import { CheckIcon, HeadsetIcon, MapPinIcon, ReturnIcon } from '@/components/cart/CartIcons';

const DELIVERY_LABEL: Record<DeliveryMethod, string> = {
  STANDARD: 'Standard Delivery',
  EXPRESS: 'Express Delivery',
  SAME_DAY: 'Same Day Delivery',
};

const STATUS_STYLES: Record<string, string> = {
  PLACED: 'bg-blue-50 text-blue-700',
  CONFIRMED: 'bg-blue-50 text-blue-700',
  PACKED: 'bg-indigo-50 text-indigo-700',
  SHIPPED: 'bg-purple-50 text-purple-700',
  DELIVERED: 'bg-green-50 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-50 text-orange-700',
  RETURNED: 'bg-red-50 text-red-700',
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
function fmtShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
function etaLabel(from: string | null, to: string | null): string {
  if (!to) return '';
  if (!from || fmtShort(from) === fmtShort(to)) return fmtShort(to);
  return `${fmtShort(from)} – ${fmtShort(to)}`;
}
function statusLabel(status: string): string {
  return status
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetailView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [returning, setReturning] = useState<OrderDetailItem | null>(null);
  const [reviewing, setReviewing] = useState<OrderDetailItem | null>(null);
  const [suggestions, setSuggestions] = useState<ProductListItem[]>([]);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    api<OrderDetailView>(`/api/orders/${params.id}`, { auth: true })
      .then(setOrder)
      .catch(() => setNotFound(true));
  }, [params.id]);

  useEffect(load, [load]);
  useEffect(() => {
    api<{ items: ProductListItem[] }>('/api/products?limit=12&sort=popularity')
      .then((r) => setSuggestions(r.items))
      .catch(() => {});
  }, []);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }

  async function buyAgain(item: OrderDetailItem) {
    if (!item.variantId) {
      router.push(`/products/${item.productSlug}`);
      return;
    }
    setBusy(item.id);
    setError('');
    try {
      await api('/api/cart/items', {
        body: { variantId: item.variantId, quantity: item.quantity },
        auth: true,
      });
      window.dispatchEvent(new Event(BADGES_EVENT));
      flash(`${item.title} added back to your cart.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add that item');
    } finally {
      setBusy('');
    }
  }

  async function cancelOrder() {
    if (!order || !confirm('Cancel this order? Stock and any credits go back.')) return;
    setBusy('cancel');
    setError('');
    try {
      await api(`/api/orders/${order.id}/cancel`, { auth: true });
      load();
      flash('Order cancelled.');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not cancel this order');
    } finally {
      setBusy('');
    }
  }

  async function copyId() {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(order.orderNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the id is on screen anyway.
    }
  }

  if (notFound) {
    return (
      <div className="py-20 text-center">
        <h1 className="t-page-title text-ink-900">Order not found</h1>
        <Link
          href="/account/orders"
          className="t-btn mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-white hover:bg-ink-800"
        >
          My Orders
        </Link>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-10 w-64 rounded-lg bg-cream-100" />
        <div className="h-96 rounded-2xl bg-cream-100" />
      </div>
    );
  }

  const savings = order.discountPaise;
  const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
  const paymentLabel =
    order.payment?.provider === 'mock' ? 'Mock gateway (dev)' : (order.payment?.provider ?? '—');
  const orderedSlugs = order.items.map((i) => i.productSlug);
  const eta = etaLabel(order.etaFrom, order.etaTo);
  const cancelled = order.status === 'CANCELLED';

  // Real stamps where we have them; the quoted ETA for what is still ahead.
  const steps = [
    { label: 'Order Placed', at: order.timeline.placedAt, expected: null as string | null },
    { label: 'Order Confirmed', at: order.timeline.confirmedAt, expected: null },
    { label: 'Shipped', at: order.timeline.shippedAt, expected: order.etaFrom },
    { label: 'Out for Delivery', at: null, expected: order.etaTo },
    { label: 'Delivered', at: order.timeline.deliveredAt, expected: order.etaTo },
  ];

  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/account/orders" className="hover:text-brand-600">
          My Orders
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Order Details</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-page-title text-ink-900">Order Details</h1>
          <p className="t-caption mt-1 flex flex-wrap items-center gap-x-2 text-gray-500">
            Order ID: <span className="font-bold text-ink-900">{order.orderNumber}</span>
            <button
              onClick={() => void copyId()}
              aria-label="Copy order id"
              className="text-gray-400 hover:text-brand-600"
            >
              {copied ? '✓' : '⧉'}
            </button>
            <span className="text-gray-300">·</span>
            Placed on {fmtDateTime(order.createdAt)}
          </p>
        </div>
        <button
          onClick={() => window.dispatchEvent(new Event(SUPPORT_CHAT_EVENT))}
          className="flex items-center gap-2.5 rounded-2xl border border-gray-200 px-4 py-3 text-left transition hover:border-brand-600"
        >
          <HeadsetIcon className="h-5 w-5 text-gray-500" />
          <span>
            <span className="t-card-label block text-ink-900">Need Help?</span>
            <span className="t-caption block text-brand-600">Chat with us</span>
          </span>
        </button>
      </div>

      {notice && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {order.awaitingPayment && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          Payment pending — this order is not confirmed yet.
        </div>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_15rem_17rem]">
        {/* ── Main column ────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-4">
          <section className="grid gap-4 rounded-2xl border border-gray-100 bg-white p-5 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div>
              <p className="t-card-label flex items-center gap-2 text-ink-900">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full ${
                    cancelled ? 'bg-gray-200 text-gray-500' : 'bg-green-600 text-white'
                  }`}
                >
                  {cancelled ? '✕' : <CheckIcon className="h-3.5 w-3.5" />}
                </span>
                {statusLabel(order.status)}
              </p>
              <p className="t-caption mt-1 text-gray-500">
                {order.timeline.deliveredAt
                  ? `Delivered on ${fmtDate(order.timeline.deliveredAt)}`
                  : cancelled
                    ? 'This order was cancelled'
                    : eta
                      ? `Estimated delivery: ${eta}`
                      : 'We will update you as it moves'}
              </p>
              <Link
                href={`/account/orders/${order.id}/invoice`}
                className="t-caption mt-3 inline-block rounded-lg border border-gray-300 px-4 py-2 font-bold text-ink-900 transition hover:border-brand-600"
              >
                ⬇ Download Invoice
              </Link>
            </div>

            <div className="sm:border-l sm:border-gray-100 sm:pl-4">
              <p className="t-caption text-gray-500">Payment Method</p>
              <p className="t-card-label mt-0.5 text-ink-900">{paymentLabel}</p>
            </div>

            <div className="sm:border-l sm:border-gray-100 sm:pl-4">
              <p className="t-caption text-gray-500">Total Paid</p>
              <p className="t-cart-price mt-0.5 text-ink-900">{formatPaise(order.totalPaise)}</p>
              {savings > 0 && (
                <p className="t-caption text-green-600">
                  You saved {formatPaise(savings)} on this order
                </p>
              )}
            </div>
          </section>

          {/* Items */}
          <section className="rounded-2xl border border-gray-100 bg-white p-5">
            <h2 className="t-sub-heading text-ink-900">
              Ordered Items{' '}
              <span className="t-caption font-normal text-gray-500">({itemCount} Items)</span>
            </h2>

            <ul className="mt-3 divide-y divide-gray-100">
              {order.items.map((item) => (
                <li key={item.id} className="flex flex-wrap items-start gap-4 py-4">
                  <Link href={`/products/${item.productSlug}`} className="shrink-0">
                    {item.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.imageUrl}
                        alt=""
                        loading="lazy"
                        className="h-20 w-16 rounded-lg bg-cream-100 object-cover"
                      />
                    ) : (
                      <div className="h-20 w-16 rounded-lg bg-cream-100" />
                    )}
                  </Link>

                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/products/${item.productSlug}`}
                      className="t-card-label line-clamp-2 text-ink-900 hover:text-brand-600"
                    >
                      {item.title}
                    </Link>
                    <p className="t-caption mt-0.5 text-gray-500">
                      {item.size !== 'One Size' && (
                        <>
                          Size: <span className="text-gray-700">{item.size}</span>
                          <span className="mx-1.5 text-gray-300">|</span>
                        </>
                      )}
                      Color: <span className="text-gray-700">{item.color}</span>
                    </p>
                    <p className="t-caption mt-0.5 text-gray-500">Sold by {item.shopName}</p>
                    <span
                      className={`t-badge mt-1.5 inline-block rounded px-2 py-0.5 ${
                        STATUS_STYLES[item.status] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {statusLabel(item.status)}
                    </span>
                    {item.courierName && item.awbNumber && (
                      <p className="t-caption mt-1 text-gray-500">
                        {item.courierName} · AWB {item.awbNumber}
                      </p>
                    )}
                    {item.returnInfo && <ReturnTimeline info={item.returnInfo} />}
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="t-card-label text-ink-900">
                      {formatPaise(item.pricePaise * item.quantity)}
                    </p>
                    <p className="t-caption text-gray-500">Qty: {item.quantity}</p>
                  </div>

                  <div className="flex shrink-0 flex-col gap-2">
                    <button
                      onClick={() => void buyAgain(item)}
                      disabled={busy === item.id}
                      className="t-caption rounded-lg border border-gray-300 px-4 py-2 font-bold text-ink-900 transition hover:border-brand-600 disabled:opacity-50"
                    >
                      {busy === item.id ? 'Adding…' : 'Buy Again'}
                    </button>
                    {item.canReview && (
                      <button
                        onClick={() => setReviewing(item)}
                        className="t-caption rounded-lg border border-gray-300 px-4 py-2 font-semibold text-gray-700 transition hover:border-brand-600 hover:text-brand-600"
                      >
                        Write a Review
                      </button>
                    )}
                    {item.canReturn && (
                      <button
                        onClick={() => setReturning(item)}
                        className="t-caption rounded-lg border border-gray-300 px-4 py-2 font-semibold text-gray-700 transition hover:border-orange-300 hover:text-orange-700"
                      >
                        Return item
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {order.canCancel && (
              <button
                onClick={() => void cancelOrder()}
                disabled={busy === 'cancel'}
                className="t-caption mt-3 rounded-lg border border-gray-300 px-4 py-2 font-semibold text-gray-600 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50"
              >
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel order'}
              </button>
            )}
          </section>

          {order.isGift && (
            <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-4">
              <p className="t-card-label text-ink-900">🎁 Sent as a gift</p>
              {order.giftMessage && (
                <p className="t-caption mt-1 text-gray-600">&ldquo;{order.giftMessage}&rdquo;</p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-white px-5 py-4">
            <p className="t-card-label flex items-center gap-2 text-ink-900">
              <CheckIcon className="h-4 w-4 text-green-600" />
              We hope you loved your order. Need help with anything?
            </p>
            <button
              onClick={() => window.dispatchEvent(new Event(SUPPORT_CHAT_EVENT))}
              className="t-btn rounded-lg border border-gray-300 px-5 py-2.5 text-ink-900 transition hover:border-brand-600"
            >
              Chat with Us
            </button>
          </div>

          {suggestions.filter((p) => !orderedSlugs.includes(p.slug)).length > 0 && (
            <section className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="t-sub-heading text-ink-900">You may also like</h2>
              <div className="mt-3">
                <Scroller>
                  {suggestions
                    .filter((p) => !orderedSlugs.includes(p.slug))
                    .slice(0, 10)
                    .map((product) => (
                      <div key={product.id} className="w-36 shrink-0 sm:w-40">
                        <ProductCard product={product} inWishlist={false} />
                      </div>
                    ))}
                </Scroller>
              </div>
            </section>
          )}
        </div>

        {/* ── Middle column ──────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="t-card-label flex items-center gap-2 text-ink-900">
              <MapPinIcon className="h-4 w-4 text-gray-500" />
              Delivery Address
            </p>
            <p className="t-card-label mt-3 text-ink-900">{order.shipTo.name}</p>
            <p className="t-caption mt-1 leading-relaxed text-gray-500">
              {order.shipTo.line1}
              {order.shipTo.line2 ? `, ${order.shipTo.line2}` : ''}
              <br />
              {order.shipTo.city}, {order.shipTo.state} - {order.shipTo.pincode}
            </p>
            <p className="t-caption mt-1 text-gray-500">+91 {order.shipTo.phone}</p>
            <Link
              href="/account/addresses"
              className="t-caption mt-3 block rounded-lg border border-gray-300 py-2 text-center font-bold text-ink-900 transition hover:bg-cream-50"
            >
              View / Manage Address
            </Link>
          </div>

          {!cancelled && (
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <p className="t-card-label text-ink-900">Order Timeline</p>
              <p className="t-caption mt-0.5 text-gray-500">
                {DELIVERY_LABEL[order.deliveryMethod]}
              </p>
              <ol className="mt-3 space-y-4">
                {steps.map((step, i) => {
                  const done = step.at !== null;
                  return (
                    <li key={step.label} className="relative flex gap-3">
                      {i < steps.length - 1 && (
                        <span
                          className={`absolute left-[0.6875rem] top-6 h-full w-0.5 ${
                            done ? 'bg-green-600' : 'bg-gray-200'
                          }`}
                        />
                      )}
                      <span
                        className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[10px] ${
                          done
                            ? 'border-green-600 bg-green-600 text-white'
                            : 'border-gray-200 bg-white text-gray-300'
                        }`}
                      >
                        {done ? <CheckIcon className="h-3 w-3" /> : '○'}
                      </span>
                      <span className="min-w-0 pb-1">
                        <span
                          className={`t-caption block font-bold ${
                            done ? 'text-ink-900' : 'text-gray-400'
                          }`}
                        >
                          {step.label}
                        </span>
                        <span className="t-caption block text-gray-400">
                          {step.at
                            ? fmtDateTime(step.at)
                            : step.expected
                              ? `Expected by ${fmtShort(step.expected)}`
                              : 'Pending'}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="t-card-label text-ink-900">Need Help?</p>
            <ul className="mt-2 divide-y divide-gray-100">
              <li>
                <button
                  onClick={() => {
                    const item = order.items.find((i) => i.canReturn);
                    if (item) setReturning(item);
                    else flash('No item in this order is inside its return window.');
                  }}
                  className="flex w-full items-center gap-2.5 py-3 text-left transition hover:text-brand-600"
                >
                  <ReturnIcon className="h-4 w-4 shrink-0 text-gray-500" />
                  <span className="t-caption min-w-0 flex-1 font-semibold text-ink-900">
                    Return / Replace Items
                  </span>
                </button>
              </li>
              <li>
                <Link
                  href="/account/help"
                  className="flex items-center gap-2.5 py-3 transition hover:text-brand-600"
                >
                  <HeadsetIcon className="h-4 w-4 shrink-0 text-gray-500" />
                  <span className="t-caption min-w-0 flex-1 font-semibold text-ink-900">
                    Report an Issue
                  </span>
                </Link>
              </li>
              <li>
                <Link
                  href={`/account/orders/${order.id}/invoice`}
                  className="flex items-center gap-2.5 py-3 transition hover:text-brand-600"
                >
                  <span className="w-4 text-center text-gray-500">⬇</span>
                  <span className="t-caption min-w-0 flex-1 font-semibold text-ink-900">
                    Download Invoice
                  </span>
                </Link>
              </li>
            </ul>
          </div>
        </div>

        {/* ── Right column ───────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="t-sub-heading text-ink-900">Order Summary</h2>
              <Link
                href={`/account/orders/${order.id}/invoice`}
                className="t-caption font-semibold text-brand-600 hover:underline"
              >
                View Invoice
              </Link>
            </div>
            <dl className="mt-3 space-y-2">
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Item Total ({itemCount} Items)</dt>
                <dd className="t-caption font-bold text-ink-900">
                  {formatPaise(order.subtotalPaise)}
                </dd>
              </div>
              {order.couponDiscountPaise > 0 && (
                <div className="flex justify-between">
                  <dt className="t-caption text-gray-600">
                    Coupon Discount{' '}
                    <span className="font-semibold text-brand-600">({order.couponCode})</span>
                  </dt>
                  <dd className="t-caption font-bold text-green-600">
                    −{formatPaise(order.couponDiscountPaise)}
                  </dd>
                </div>
              )}
              {order.creditsUsed > 0 && (
                <div className="flex justify-between">
                  <dt className="t-caption text-gray-600">Clowe Credits ({order.creditsUsed} 🪙)</dt>
                  <dd className="t-caption font-bold text-green-600">
                    −{formatPaise(order.discountPaise - order.couponDiscountPaise)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Shipping Charges</dt>
                <dd
                  className={`t-caption font-bold ${
                    order.shippingPaise === 0 ? 'text-green-600' : 'text-ink-900'
                  }`}
                >
                  {order.shippingPaise === 0 ? 'FREE' : formatPaise(order.shippingPaise)}
                </dd>
              </div>
            </dl>
            <div className="mt-3 flex items-baseline justify-between border-t border-gray-200 pt-3">
              <span className="t-card-label text-ink-900">
                Total Paid
                <span className="t-caption block font-normal text-gray-400">
                  (Inclusive of all taxes)
                </span>
              </span>
              <span className="t-cart-subtotal text-ink-900">{formatPaise(order.totalPaise)}</span>
            </div>
            {savings > 0 && (
              <p className="t-caption mt-3 rounded-lg bg-green-50 px-3 py-2 text-center font-semibold text-green-700">
                You saved {formatPaise(savings)} on this order!
              </p>
            )}
          </div>

          {order.earnedCredits > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-brand-100 bg-brand-50/50 p-4">
              <div className="min-w-0">
                <p className="t-card-label text-ink-900">Earned Clowe Credits</p>
                <Link
                  href="/account/credits"
                  className="t-caption text-gray-600 hover:text-brand-600"
                >
                  Credited to your account →
                </Link>
              </div>
              <span className="t-cart-price shrink-0 text-brand-700">+ {order.earnedCredits}</span>
            </div>
          )}

          <div className="overflow-hidden rounded-2xl bg-ink-950 p-5 text-white">
            <p className="t-sub-heading text-brand-400">♛ CLOWE Premium</p>
            <p className="t-caption mt-1 text-gray-300">Thank you for shopping with CLOWE!</p>
            <ul className="mt-3 space-y-1.5">
              {[
                'Early access to sales',
                'Member-only coupons',
                'Priority customer support',
                'Free & fast delivery',
              ].map((perk) => (
                <li key={perk} className="t-caption flex items-start gap-2 text-gray-300">
                  <span className="text-brand-400">✦</span>
                  {perk}
                </li>
              ))}
            </ul>
            <Link
              href="/pages/help"
              className="t-btn mt-4 block rounded-lg bg-brand-600 py-2.5 text-center text-white transition hover:bg-brand-700"
            >
              Explore Premium ›
            </Link>
          </div>
        </aside>
      </div>

      {returning && (
        <ReturnModal
          item={returning}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            load();
            flash('Return requested — the seller has been notified.');
          }}
        />
      )}
      {reviewing && (
        <ReviewModal
          item={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            load();
            flash('Thanks — your review is live.');
          }}
        />
      )}
    </div>
  );
}
