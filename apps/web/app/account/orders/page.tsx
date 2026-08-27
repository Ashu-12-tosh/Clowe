'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ORDER_FILTERS,
  ORDER_FILTER_LABELS,
  type OrderFilter,
  type OrderListResponse,
  type OrderListRow,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BADGES_EVENT } from '@/components/Header';
import { SUPPORT_CHAT_EVENT } from '@/components/SupportChat';
import {
  BoxIcon,
  CheckIcon,
  HeadsetIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

const PAGE_SIZE = 10;

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns within 7 days' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

const SUMMARY_ROWS: { filter: OrderFilter; icon: string; tint: string }[] = [
  { filter: 'ALL', icon: '📅', tint: 'text-ink-900' },
  { filter: 'DELIVERED', icon: '✓', tint: 'text-green-600' },
  { filter: 'SHIPPED', icon: '🚚', tint: 'text-blue-600' },
  { filter: 'PROCESSING', icon: '⏳', tint: 'text-purple-600' },
  { filter: 'CANCELLED', icon: '⊗', tint: 'text-red-600' },
  { filter: 'RETURNED', icon: '↩', tint: 'text-orange-600' },
];

const STATUS_LOOK: Record<string, { tint: string; icon: string }> = {
  PLACED: { tint: 'text-purple-600', icon: '⏳' },
  CONFIRMED: { tint: 'text-purple-600', icon: '⏳' },
  PACKED: { tint: 'text-purple-600', icon: '📦' },
  SHIPPED: { tint: 'text-blue-600', icon: '🚚' },
  DELIVERED: { tint: 'text-green-600', icon: '✓' },
  CANCELLED: { tint: 'text-gray-500', icon: '⊗' },
  RETURN_REQUESTED: { tint: 'text-orange-600', icon: '↩' },
  RETURNED: { tint: 'text-orange-600', icon: '↩' },
};

function statusLabel(status: string): string {
  return status
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}
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

/** The one line under the status badge. */
function statusDetail(order: OrderListRow): string {
  if (order.deliveredAt) return `Delivered on ${fmtDate(order.deliveredAt)}`;
  if (order.status === 'CANCELLED') return 'This order was cancelled';
  if (order.status === 'RETURN_REQUESTED') return 'Return in progress';
  if (order.status === 'RETURNED') return 'Returned';
  if (order.etaTo) return `Expected by ${fmtShort(order.etaTo)}`;
  return 'Your order is being processed';
}

export default function MyOrdersPage() {
  const router = useRouter();
  const [data, setData] = useState<OrderListResponse | null>(null);
  const [filter, setFilter] = useState<OrderFilter>('ALL');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const params = new URLSearchParams({
      status: filter,
      page: String(page),
      limit: String(PAGE_SIZE),
    });
    if (applied) params.set('q', applied);
    api<OrderListResponse>(`/api/orders?${params.toString()}`, { auth: true })
      .then(setData)
      .catch(() => setError('Could not load your orders'));
  }, [filter, page, applied]);

  useEffect(load, [load]);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }

  async function buyAgain(order: OrderListRow) {
    setMenuId(null);
    setBusy(order.id);
    setError('');
    try {
      const result = await api<{ moved: number; skipped: string[] }>(
        `/api/orders/${order.id}/buy-again`,
        { auth: true },
      );
      window.dispatchEvent(new Event(BADGES_EVENT));
      flash(
        result.skipped.length > 0
          ? `${result.moved} item(s) added · ${result.skipped.length} unavailable`
          : `${result.moved} item${result.moved === 1 ? '' : 's'} added back to your cart`,
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add those items');
    } finally {
      setBusy('');
    }
  }

  async function copyId(orderNumber: string) {
    setMenuId(null);
    try {
      await navigator.clipboard.writeText(orderNumber);
      flash(`Order ID ${orderNumber} copied`);
    } catch {
      // Clipboard blocked — the id is on screen anyway.
    }
  }

  if (!data) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-12 w-64 rounded-lg bg-cream-100" />
        <div className="h-96 rounded-2xl bg-cream-100" />
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-page-title text-ink-900">My Orders</h1>
          <p className="t-section-desc mt-1 text-gray-500">
            Track, manage and view all your orders in one place.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setApplied(query.trim());
                  setPage(1);
                }
              }}
              placeholder="Search by Order ID or Product"
              aria-label="Search orders"
              className="t-body w-64 rounded-lg border border-gray-300 py-2.5 pl-3 pr-9 outline-none focus:border-brand-600"
            />
            <button
              onClick={() => {
                setApplied(query.trim());
                setPage(1);
              }}
              aria-label="Search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-brand-600"
            >
              ⌕
            </button>
          </div>
          {applied && (
            <button
              onClick={() => {
                setQuery('');
                setApplied('');
                setPage(1);
              }}
              className="t-btn rounded-lg border border-gray-300 px-4 py-2.5 text-gray-600"
            >
              Clear ✕
            </button>
          )}
        </div>
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

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          {/* Chips */}
          <div className="flex flex-wrap gap-2">
            {ORDER_FILTERS.map((key) => (
              <button
                key={key}
                onClick={() => {
                  setFilter(key);
                  setPage(1);
                }}
                className={`t-btn rounded-full px-4 py-2 transition ${
                  filter === key
                    ? 'bg-ink-900 text-white'
                    : 'border border-gray-300 text-gray-600 hover:border-ink-900'
                }`}
              >
                {ORDER_FILTER_LABELS[key]} ({data.summary.counts[key]})
              </button>
            ))}
          </div>

          {/* Orders */}
          {data.items.length === 0 ? (
            <div className="rounded-2xl border border-gray-100 bg-white py-16 text-center">
              <span className="text-4xl">📦</span>
              <p className="t-body mt-3 text-gray-500">
                {applied
                  ? `No orders match “${applied}”.`
                  : filter === 'ALL'
                    ? 'You haven’t placed an order yet.'
                    : `No ${ORDER_FILTER_LABELS[filter].toLowerCase()}.`}
              </p>
              <Link
                href="/products"
                className="t-btn mt-4 inline-block rounded-lg bg-ink-900 px-6 py-2.5 text-white hover:bg-ink-800"
              >
                Start Shopping
              </Link>
            </div>
          ) : (
            <ul className="space-y-3">
              {data.items.map((order) => {
                const look = STATUS_LOOK[order.status] ?? { tint: 'text-gray-600', icon: '•' };
                const extra = order.productCount - order.previewImages.length;
                return (
                  <li
                    key={order.id}
                    className="flex flex-wrap items-start gap-4 rounded-2xl border border-gray-100 bg-white p-4"
                  >
                    {/* Thumbnails */}
                    <div className="flex shrink-0 gap-1.5">
                      {order.previewImages.map((url, i) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={`${order.id}-${i}`}
                          src={url}
                          alt=""
                          loading="lazy"
                          className="h-16 w-14 rounded-lg bg-cream-100 object-cover"
                        />
                      ))}
                      {extra > 0 && (
                        <span className="t-caption flex h-16 w-10 items-center justify-center rounded-lg bg-cream-100 font-bold text-gray-500">
                          +{extra}
                        </span>
                      )}
                    </div>

                    {/* Meta */}
                    <div className="min-w-0 flex-1">
                      <p className="t-card-label flex flex-wrap items-center gap-x-2 text-ink-900">
                        Order ID: {order.orderNumber}
                        <button
                          onClick={() => void copyId(order.orderNumber)}
                          aria-label="Copy order id"
                          className="text-gray-400 hover:text-brand-600"
                        >
                          ⧉
                        </button>
                      </p>
                      <p className="t-caption mt-1 text-gray-500">
                        {fmtDateTime(order.createdAt)}
                        <span className="mx-1.5 text-gray-300">·</span>
                        {order.itemCount} Item{order.itemCount === 1 ? '' : 's'}
                      </p>
                      <p className="t-caption mt-1 text-gray-600">
                        Total: <span className="font-bold text-ink-900">
                          {formatPaise(order.totalPaise)}
                        </span>
                        {order.paymentProvider && (
                          <>
                            <span className="mx-1.5 text-gray-300">•</span>
                            Paid via {order.paymentProvider}
                          </>
                        )}
                      </p>
                    </div>

                    {/* Status + actions */}
                    <div className="min-w-48 shrink-0">
                      <p className={`t-card-label flex items-center gap-1.5 ${look.tint}`}>
                        {look.icon} {statusLabel(order.status)}
                      </p>
                      <p className="t-caption mt-0.5 text-gray-500">{statusDetail(order)}</p>
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {(order.status === 'SHIPPED' || order.status === 'CONFIRMED' || order.status === 'PACKED') && (
                          <Link
                            href={`/track?orderNumber=${encodeURIComponent(order.orderNumber)}`}
                            className="t-caption rounded-lg border border-brand-600 px-4 py-2 font-bold text-brand-700 transition hover:bg-brand-50"
                          >
                            Track Order
                          </Link>
                        )}
                        <Link
                          href={`/account/orders/${order.id}`}
                          className="t-caption rounded-lg border border-gray-300 px-4 py-2 font-bold text-ink-900 transition hover:border-brand-600"
                        >
                          View Details
                        </Link>
                        {order.status === 'DELIVERED' && (
                          <button
                            onClick={() => void buyAgain(order)}
                            disabled={busy === order.id || !order.canBuyAgain}
                            className="t-caption rounded-lg bg-ink-900 px-4 py-2 font-bold text-white transition hover:bg-ink-800 disabled:opacity-40"
                          >
                            {busy === order.id ? 'Adding…' : 'Buy Again'}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Row menu */}
                    <div className="relative shrink-0">
                      <button
                        onClick={() => setMenuId(menuId === order.id ? null : order.id)}
                        aria-label="Order actions"
                        className="rounded-full px-2 py-1 text-lg leading-none text-gray-400 hover:bg-cream-100"
                      >
                        ⋮
                      </button>
                      {menuId === order.id && (
                        <div className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-xl border border-gray-100 bg-white py-1 shadow-xl">
                          <Link
                            href={`/account/orders/${order.id}`}
                            className="t-caption block px-4 py-2 text-gray-700 hover:bg-cream-100"
                          >
                            View details
                          </Link>
                          <Link
                            href={`/account/orders/${order.id}/invoice`}
                            className="t-caption block px-4 py-2 text-gray-700 hover:bg-cream-100"
                          >
                            Download invoice
                          </Link>
                          <button
                            onClick={() => void copyId(order.orderNumber)}
                            className="t-caption block w-full px-4 py-2 text-left text-gray-700 hover:bg-cream-100"
                          >
                            Copy order ID
                          </button>
                          <button
                            onClick={() => {
                              setMenuId(null);
                              router.push('/account/help');
                            }}
                            className="t-caption block w-full px-4 py-2 text-left text-gray-700 hover:bg-cream-100"
                          >
                            Need help with this order
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                aria-label="Previous page"
                className="h-8 w-8 rounded-lg border border-gray-300 disabled:opacity-40"
              >
                ‹
              </button>
              {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  onClick={() => setPage(n)}
                  className={`t-table-head h-8 w-8 rounded-lg border ${
                    n === page ? 'border-ink-900 bg-ink-900 text-white' : 'border-gray-300 text-ink-900'
                  }`}
                >
                  {n}
                </button>
              ))}
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                aria-label="Next page"
                className="h-8 w-8 rounded-lg border border-gray-300 disabled:opacity-40"
              >
                ›
              </button>
            </div>
          )}

          {/* Can't find your order */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-white px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-lg">
                🎧
              </span>
              <div>
                <p className="t-card-label text-ink-900">Can&apos;t find your order?</p>
                <p className="t-caption text-gray-500">Visit our Help Center or chat with us.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Link
                href="/account/help"
                className="t-btn rounded-lg border border-gray-300 px-5 py-2.5 text-ink-900 transition hover:border-brand-600"
              >
                Help Center
              </Link>
              <button
                onClick={() => window.dispatchEvent(new Event(SUPPORT_CHAT_EVENT))}
                className="t-btn rounded-lg bg-ink-900 px-5 py-2.5 text-white transition hover:bg-ink-800"
              >
                💬 Chat with Us
              </button>
            </div>
          </div>
        </div>

        {/* ── Right rail ─────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Orders Summary</h2>
            <ul className="mt-3 space-y-2.5">
              {SUMMARY_ROWS.map((row) => (
                <li key={row.filter} className="flex items-center gap-2.5">
                  <span className={`w-5 text-center ${row.tint}`}>{row.icon}</span>
                  <span className="t-caption min-w-0 flex-1 text-gray-600">
                    {row.filter === 'ALL' ? 'Total Orders' : ORDER_FILTER_LABELS[row.filter]}
                  </span>
                  <span className={`t-card-label shrink-0 ${row.tint}`}>
                    {data.summary.counts[row.filter]}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="overflow-hidden rounded-2xl bg-ink-950 p-5 text-white">
            <p className="t-sub-heading text-brand-400">♛ CLOWE Premium</p>
            {data.summary.totalSavedPaise > 0 && (
              <p className="t-card-label mt-2">
                You saved{' '}
                <span className="text-brand-400">
                  {formatPaise(data.summary.totalSavedPaise)}
                </span>{' '}
                on your orders!
              </p>
            )}
            <ul className="mt-3 space-y-1.5">
              {[
                'Free & fast delivery',
                'Member-only coupons',
                'Priority customer support',
                'Early access to sales',
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

          <div className="flex items-start gap-2.5 rounded-2xl border border-gray-100 bg-white p-4">
            <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            <p className="t-caption text-gray-600">
              Delivered orders can be returned within 7 days from the order details page.
            </p>
          </div>
        </aside>
      </div>

      {/* Trust strip */}
      <section className="grid gap-3 rounded-2xl border border-gray-100 bg-white p-5 sm:grid-cols-2 lg:grid-cols-5">
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
    </div>
  );
}
