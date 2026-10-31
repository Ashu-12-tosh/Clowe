'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { summarizeOrderTracking, type OrderDetailItem, type OrderDetailView, type ParcelTracking, type ProductListItem } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise, istDay, paymentMethodLabel } from '@/lib/format';
import { orderMoneyView } from '@/lib/paymentView';
import { BADGES_EVENT } from '@/components/Header';
import { SUPPORT_CHAT_EVENT } from '@/components/SupportChat';
import { Scroller } from '@/components/home/HomeBits';
import ProductCard from '@/components/ProductCard';
import { ReturnModal } from '@/components/orders/ReturnBits';
import { OrderTracking, refreshNote } from '@/components/orders/TrackingBar';
import { ParcelStatus } from '@/components/orders/ParcelBits';
import { ClaimModal } from '@/components/orders/ClaimModal';
import ReviewModal from '@/components/orders/ReviewModal';
import ReturnRule from '@/components/ReturnRule';
import NonCancellable from '@/components/NonCancellable';
import { CheckIcon, HeadsetIcon, MapPinIcon, ReturnIcon } from '@/components/cart/CartIcons';

const STATUS_STYLES: Record<string, string> = {
  PLACED: 'bg-blue-50 text-blue-700',
  CONFIRMED: 'bg-blue-50 text-blue-700',
  PACKED: 'bg-indigo-50 text-indigo-700',
  SHIPPED: 'bg-purple-50 text-purple-700',
  DELIVERED: 'bg-green-50 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-50 text-orange-700',
  RETURNED: 'bg-red-50 text-red-700',
  RTO_IN_TRANSIT: 'bg-red-50 text-red-700',
  RTO_DELIVERED: 'bg-red-50 text-red-700',
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
// Indian calendar dates, as checkout quotes them: in the browser's own zone a
// window could read a day off what checkout said (pre-launch audit L5).
function fmtShort(iso: string): string {
  return istDay(iso);
}
function etaLabel(from: string | null, to: string | null): string {
  if (!to) return '';
  if (!from || fmtShort(from) === fmtShort(to)) return fmtShort(to);
  return `${fmtShort(from)} – ${fmtShort(to)}`;
}
const NOT_ON_THE_WAY = new Set(['DELIVERED', 'CANCELLED', 'RETURNED', 'RETURN_REQUESTED', 'REFUNDED']);

/**
 * The window the header quotes: Delhivery's own date for a parcel it has
 * booked, each dispatched parcel's own window (from its dispatch date) for
 * what is on its way, and the seller's promise from checkout for what has
 * not left yet — so the page never shows two different windows for the same
 * goods (pre-launch audit L5).
 */
function currentEtaWindow(order: OrderDetailView): { from: string | null; to: string | null } {
  const windows: { from: string; to: string }[] = [];
  for (const item of order.items) {
    if (NOT_ON_THE_WAY.has(item.status)) continue;
    const parcel = item.parcel;
    if (parcel?.courierPromisedAt) windows.push({ from: parcel.courierPromisedAt, to: parcel.courierPromisedAt });
    else if (item.status === 'SHIPPED' && parcel?.etaFrom && parcel.etaTo) windows.push({ from: parcel.etaFrom, to: parcel.etaTo });
    else if (item.deliveryPromise) {
      windows.push({ from: item.deliveryPromise.deliveryBy, to: item.deliveryPromise.deliveryByLatest ?? item.deliveryPromise.deliveryBy });
    } else if (order.etaFrom && order.etaTo) windows.push({ from: order.etaFrom, to: order.etaTo });
  }
  if (windows.length === 0) return { from: order.etaFrom, to: order.etaTo };
  const from = windows.reduce((a, w) => (w.from < a ? w.from : a), windows[0]!.from);
  const to = windows.reduce((a, w) => (w.to > a ? w.to : a), windows[0]!.to);
  return { from, to };
}

function statusLabel(status: string): string {
  return status
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

export default function OrderDetailPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = use(paramsPromise);
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
  const [refreshing, setRefreshing] = useState(false);
  const [trackNote, setTrackNote] = useState('');

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
    if (!order || !confirm('Cancel this order? Anything you paid is refunded in full.')) return;
    setBusy('cancel');
    setError('');
    try {
      const done = await api<{ kept: number }>(`/api/orders/${order.id}/cancel`, { method: 'POST', auth: true });
      load();
      flash(
        done.kept > 0
          ? `Cancelled. ${done.kept === 1 ? 'One item is' : `${done.kept} items are`} non-cancellable and will still be delivered.`
          : 'Order cancelled.',
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not cancel this order');
    } finally {
      setBusy('');
    }
  }

  async function requestIntercept() {
    if (!order || !confirm('Ask us to stop this parcel? We will try with the seller and the courier; if it cannot be stopped, you can refuse it at the door.')) return;
    setBusy('intercept');
    setError('');
    try {
      const { complaintId } = await api<{ complaintId: string }>(`/api/orders/${order.id}/intercept`, {
        method: 'POST',
        auth: true,
        body: {},
      });
      load();
      flash(`Request ${complaintId} sent — we will update you within 48 hours.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send your request');
    } finally {
      setBusy('');
    }
  }

  async function refreshTracking() {
    if (!order) return;
    setRefreshing(true);
    setTrackNote('');
    try {
      const r = await api<{ asked: number; cached: number; nextRefreshAt: string | null; tracking: ParcelTracking[] }>(
        `/api/orders/${order.id}/tracking/refresh`,
        { method: 'POST', auth: true, quiet: true },
      );
      setOrder((o) => (o ? { ...o, tracking: r.tracking } : o));
      setTrackNote(refreshNote(r));
    } catch (err) {
      setTrackNote(err instanceof ApiRequestError ? err.message : 'Could not check with the courier — try again in a minute.');
    } finally {
      setRefreshing(false);
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
  const paymentLabel = paymentMethodLabel(order.paymentMethod, order.payment?.provider);
  const orderedSlugs = order.items.map((i) => i.productSlug);
  const etaWindow = currentEtaWindow(order);
  const eta = etaLabel(etaWindow.from, etaWindow.to);
  const cancelled = order.status === 'CANCELLED';
  // "Paid" only when the money was taken: an order whose payment is pending or
  // failed shows what it costs, not what was paid.
  const { totalLabel, notPaidNote, showInvoice } = orderMoneyView(order);
  const tracking = summarizeOrderTracking(order.tracking);

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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          <span>Not paid yet — this order is confirmed once the payment goes through.</span>
          <span className="flex flex-wrap gap-2">
            <Link
              href={`/checkout/return?kind=ORDER&id=${encodeURIComponent(order.id)}&pay=1`}
              className="t-caption rounded-lg bg-brand-600 px-4 py-2 font-bold text-white hover:bg-brand-700"
            >
              Retry payment
            </Link>
            <Link
              href={`/checkout/return?kind=ORDER&id=${encodeURIComponent(order.id)}`}
              className="t-caption rounded-lg border border-yellow-300 bg-white px-4 py-2 font-bold text-ink-900 hover:border-brand-600"
            >
              Check payment status
            </Link>
          </span>
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
                {tracking
                  ? tracking.headline
                  : order.timeline.deliveredAt
                  ? `Delivered on ${fmtDate(order.timeline.deliveredAt)}`
                  : cancelled
                    ? 'This order was cancelled'
                    : eta
                      ? `Estimated delivery: ${eta}`
                      : 'We will update you as it moves'}
              </p>
              {showInvoice && (
                <Link
                  href={`/account/orders/${order.id}/invoice`}
                  className="t-caption mt-3 inline-block rounded-lg border border-gray-300 px-4 py-2 font-bold text-ink-900 transition hover:border-brand-600"
                >
                  ⬇ Download Invoice
                </Link>
              )}
            </div>

            <div className="sm:border-l sm:border-gray-100 sm:pl-4">
              <p className="t-caption text-gray-500">Payment Method</p>
              <p className="t-card-label mt-0.5 text-ink-900">{paymentLabel}</p>
            </div>

            <div className="sm:border-l sm:border-gray-100 sm:pl-4">
              <p className="t-caption text-gray-500">{totalLabel}</p>
              <p className="t-cart-price mt-0.5 text-ink-900">{formatPaise(order.totalPaise)}</p>
              {notPaidNote && <p className="t-caption font-semibold text-red-600">{notPaidNote}</p>}
              {savings > 0 && (
                <p className="t-caption text-green-600">
                  You saved {formatPaise(savings)} on this order
                </p>
              )}
            </div>
          </section>

          {/* Where each parcel is */}
          <section id="tracking" aria-labelledby="tracking-heading" className="scroll-mt-24 space-y-3">
            <h2 id="tracking-heading" className="t-sub-heading text-ink-900">
              Track your order
            </h2>
            <OrderTracking parcels={order.tracking} onRefresh={() => void refreshTracking()} refreshing={refreshing} note={trackNote} />
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
                    {item.variantLabel && (
                      <p className="t-caption mt-0.5 text-gray-500">
                        <span className="text-gray-700">{item.variantLabel}</span>
                      </p>
                    )}
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
                    {item.status === 'CANCELLED' && item.cancelReason && (
                      <p className="t-caption mt-1 text-gray-600">Cancelled: {item.cancelReason}</p>
                    )}
                    {item.status !== 'CANCELLED' && <ReturnRule returnable={item.returnable} className="mt-1" />}
                    <ParcelStatus orderId={order.id} item={item} onChanged={load} />
                    {item.returnInfo?.refund?.arn && (
                      <p className="t-caption mt-1 text-gray-500">
                        Refund bank reference: <span className="font-mono">{item.returnInfo.refund.arn}</span>
                      </p>
                    )}
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
                        {item.claim ? 'Report a problem' : 'Return item'}
                      </button>
                    )}
                    {item.nonCancellable && ['PLACED', 'CONFIRMED', 'PACKED'].includes(item.status) && (
                      <NonCancellable className="self-center" />
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
            {order.canRequestIntercept && (
              <div className="mt-3">
                <button
                  onClick={() => void requestIntercept()}
                  disabled={busy === 'intercept'}
                  className="t-caption rounded-lg border border-gray-300 px-4 py-2 font-semibold text-gray-600 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50"
                >
                  {busy === 'intercept' ? 'Sending…' : 'Stop this parcel'}
                </button>
                <p className="t-caption mt-1 text-gray-500">
                  It has shipped, so it can no longer be cancelled. We can ask the seller and the courier to stop it; if they
                  can&apos;t, you may refuse it at the door and get a full refund.
                </p>
              </div>
            )}
            {order.interceptRequest && (
              <p className="t-caption mt-3 rounded-lg bg-amber-50 px-3 py-2 text-amber-800" data-intercept-request>
                You asked us to stop this parcel — request {order.interceptRequest.complaintId} (
                {order.interceptRequest.status.replace(/_/g, ' ').toLowerCase()}).
              </p>
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
              {showInvoice && (
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
              )}
            </ul>
          </div>
        </div>

        {/* ── Right column ───────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="t-sub-heading text-ink-900">Order Summary</h2>
              {showInvoice && (
                <Link
                  href={`/account/orders/${order.id}/invoice`}
                  className="t-caption font-semibold text-brand-600 hover:underline"
                >
                  View Invoice
                </Link>
              )}
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
                {totalLabel}
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
        </aside>
      </div>

      {returning?.claim && (
        <ClaimModal
          item={{ ...returning, claim: returning.claim }}
          cod={order.paymentMethod === 'COD'}
          onClose={() => setReturning(null)}
          onDone={(rma) => {
            setReturning(null);
            load();
            flash(`Claim ${rma} sent — the seller decides within 48 hours.`);
          }}
        />
      )}
      {returning && !returning.claim && (
        <ReturnModal
          item={returning}
          cod={order.paymentMethod === 'COD'}
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
