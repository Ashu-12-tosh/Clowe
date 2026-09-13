'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  RETURN_FILTERS,
  RETURN_FILTER_LABELS,
  RETURN_REASON_LABELS,
  type MyReturnRow,
  type MyReturnsResponse,
  type ReturnFilter,
  type ReturnReasonValue,
} from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { SUPPORT_CHAT_EVENT } from '@/components/SupportChat';
import {
  BoxIcon,
  ClockIcon,
  HeadsetIcon,
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

const STATUS_PILL: Record<string, string> = {
  REQUESTED: 'bg-brand-50 text-brand-700',
  APPROVED: 'bg-blue-50 text-blue-700',
  RECEIVED: 'bg-purple-50 text-purple-700',
  REFUNDED: 'bg-green-50 text-green-700',
  REJECTED: 'bg-red-50 text-red-600',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** The status detail block under each badge — real dates, real reasons. */
function StatusDetail({ row }: { row: MyReturnRow }) {
  if (row.status === 'REFUNDED' && row.refund) {
    return (
      <>
        <p className="t-caption text-gray-500">
          {row.refund.processedAt
            ? `Refunded on ${fmtDate(row.refund.processedAt)}`
            : 'Refund initiated'}
        </p>
        <p className="t-caption mt-0.5 text-gray-500">
          Refund Amount
          <span className="ml-1 font-bold text-ink-900">
            {formatPaise(row.refund.amountPaise)}
          </span>
        </p>
      </>
    );
  }
  if (row.status === 'REJECTED') {
    return (
      <>
        <p className="t-caption text-gray-500">
          {row.rejectedAt ? `Rejected on ${fmtDate(row.rejectedAt)}` : 'Rejected'}
        </p>
        {row.rejectionReason && (
          <p className="t-caption mt-0.5 line-clamp-2 text-red-600">{row.rejectionReason}</p>
        )}
      </>
    );
  }
  if (row.status === 'RECEIVED') {
    return (
      <>
        <p className="t-caption text-gray-500">
          {row.receivedAt ? `Received on ${fmtDate(row.receivedAt)}` : 'With the seller'}
        </p>
        <p className="t-caption mt-0.5 text-gray-500">Refund starts once checks pass</p>
      </>
    );
  }
  if (row.status === 'APPROVED') {
    return (
      <>
        <p className="t-caption text-gray-500">
          {row.approvedAt ? `Approved on ${fmtDate(row.approvedAt)}` : 'Pickup scheduled'}
        </p>
        {row.awbNumber && (
          <p className="t-caption mt-0.5 text-gray-500">
            {row.courierName ? `${row.courierName} · ` : ''}AWB {row.awbNumber}
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <p className="t-caption text-gray-500">Request ID: {row.requestId}</p>
      <p className="t-caption mt-0.5 text-gray-500">Requested on {fmtDate(row.requestedAt)}</p>
    </>
  );
}

export default function ReturnsPage() {
  const [data, setData] = useState<MyReturnsResponse | null>(null);
  const [filter, setFilter] = useState<ReturnFilter>('ALL');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<MyReturnsResponse>(`/api/me/returns?status=${filter}`, { auth: true })
      .then(setData)
      .catch(() => setError('Could not load your returns'));
  }, [filter]);

  useEffect(load, [load]);

  if (!data) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-12 w-64 rounded-lg bg-cream-100" />
        <div className="h-96 rounded-2xl bg-cream-100" />
      </div>
    );
  }

  const POLICY = [
    {
      Icon: ReturnIcon,
      title: 'Easy Returns',
      text: `Return within ${data.returnWindowDays} days of delivery`,
    },
    {
      Icon: ShieldCheckIcon,
      title: 'Product Condition',
      text: 'Item must be unused, unwashed and in original condition',
    },
    {
      Icon: BoxIcon,
      title: 'Original Packaging',
      text: 'Product must be returned in original packaging with tags',
    },
    {
      Icon: ClockIcon,
      title: 'Refund Time',
      text: 'Refunds are processed within 5–7 business days',
    },
  ];

  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        <Link href="/account" className="hover:text-brand-600">
          My Account
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Returns &amp; Refunds</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-page-title text-ink-900">Returns &amp; Refunds</h1>
          <p className="t-section-desc mt-1 text-gray-500">
            Request returns, track status and view refund details.
          </p>
        </div>
        <Link
          href="/pages/return-policy"
          className="t-btn rounded-lg border border-gray-300 px-4 py-2.5 text-ink-900 transition hover:border-brand-600"
        >
          🛡 Return Policy
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-4">
          {/* Tabs */}
          <div className="scrollbar-none flex gap-1 overflow-x-auto border-b border-gray-200">
            {RETURN_FILTERS.map((key) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`t-nav shrink-0 border-b-2 px-4 py-3 transition ${
                  filter === key
                    ? 'border-brand-600 text-brand-600'
                    : 'border-transparent text-gray-600 hover:text-ink-900'
                }`}
              >
                {RETURN_FILTER_LABELS[key]}
                {data.summary.counts[key] > 0 && (
                  <span className="ml-1.5 text-gray-400">({data.summary.counts[key]})</span>
                )}
              </button>
            ))}
          </div>

          {/* Rows */}
          {data.items.length === 0 ? (
            <div className="rounded-2xl border border-gray-100 bg-white py-16 text-center">
              <span className="text-4xl">↩</span>
              <p className="t-body mt-3 text-gray-500">
                {filter === 'ALL'
                  ? "You haven't requested any returns."
                  : `No returns in ${RETURN_FILTER_LABELS[filter].toLowerCase()}.`}
              </p>
              <p className="t-caption mt-1 text-gray-400">
                Start one from a delivered item inside an order.
              </p>
              <Link
                href="/orders"
                className="t-btn mt-4 inline-block rounded-lg bg-ink-900 px-6 py-2.5 text-white hover:bg-ink-800"
              >
                View delivered orders
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white">
              {data.items.map((row) => (
                <li key={row.id} className="flex flex-wrap items-start gap-4 p-4">
                  <Link href={`/products/${row.productSlug}`} className="shrink-0">
                    {row.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={row.imageUrl}
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
                      href={`/products/${row.productSlug}`}
                      className="t-card-label line-clamp-2 text-ink-900 hover:text-brand-600"
                    >
                      {row.productTitle}
                    </Link>
                    {row.variantLabel && (
                      <p className="t-caption mt-0.5 text-gray-500">{row.variantLabel}</p>
                    )}
                    <p className="t-caption mt-1 text-gray-500">
                      Order ID:{' '}
                      <Link
                        href={`/account/orders/${row.orderId}`}
                        className="font-semibold text-brand-600 hover:underline"
                      >
                        #{row.orderNumber}
                      </Link>
                      <span className="mx-1.5 text-gray-300">|</span>
                      Ordered on {fmtDate(row.orderedAt)}
                    </p>
                    <p className="t-card-label mt-1 text-ink-900">
                      {formatPaise(row.pricePaise * row.quantity)}
                      <span className="t-caption ml-2 font-normal text-gray-500">
                        {row.quantity} item{row.quantity === 1 ? '' : 's'}
                      </span>
                    </p>
                    <p className="t-caption mt-1 text-gray-500">
                      Reason:{' '}
                      <span className="font-medium text-ink-900">
                        {RETURN_REASON_LABELS[row.reason as ReturnReasonValue] ?? row.reason}
                      </span>
                    </p>
                  </div>

                  <div className="min-w-44 shrink-0">
                    <span
                      className={`t-badge inline-block rounded px-2.5 py-1 ${
                        STATUS_PILL[row.status] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {RETURN_FILTER_LABELS[row.status as ReturnFilter] ?? row.status}
                    </span>
                    <div className="mt-2">
                      <StatusDetail row={row} />
                    </div>
                  </div>

                  <Link
                    href={`/account/orders/${row.orderId}`}
                    className="t-caption shrink-0 rounded-lg border border-gray-300 px-4 py-2 font-bold text-ink-900 transition hover:border-brand-600"
                  >
                    View Details ›
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* Help strip */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-brand-50/60 px-5 py-4">
            <div className="flex items-center gap-3">
              <BoxIcon className="h-6 w-6 shrink-0 text-brand-600" />
              <div>
                <p className="t-card-label text-ink-900">Need help with your return?</p>
                <p className="t-caption text-gray-600">
                  Our support team can help with any return or refund query.
                </p>
              </div>
            </div>
            <button
              onClick={() => window.dispatchEvent(new Event(SUPPORT_CHAT_EVENT))}
              className="t-btn rounded-lg border border-brand-600 px-5 py-2.5 text-brand-700 transition hover:bg-brand-50"
            >
              🎧 Contact Support
            </button>
          </div>
        </div>

        {/* ── Right rail ─────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Return Policy Highlights</h2>
            <ul className="mt-3 space-y-3">
              {POLICY.map(({ Icon, title, text }) => (
                <li key={title} className="flex items-start gap-2.5">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                  <div className="min-w-0">
                    <p className="t-card-label text-ink-900">{title}</p>
                    <p className="t-caption text-gray-500">{text}</p>
                  </div>
                </li>
              ))}
            </ul>
            <Link
              href="/pages/return-policy"
              className="t-caption mt-3 inline-block font-semibold text-brand-600 hover:underline"
            >
              View Full Return Policy ›
            </Link>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Refund Summary</h2>
            <dl className="mt-3 space-y-2.5">
              {(['ALL', 'REFUNDED', 'RECEIVED', 'REJECTED'] as ReturnFilter[]).map((key) => (
                <div key={key} className="flex justify-between">
                  <dt className="t-caption text-gray-600">
                    {key === 'ALL' ? 'Total Returns' : RETURN_FILTER_LABELS[key]}
                  </dt>
                  <dd className="t-card-label text-ink-900">{data.summary.counts[key]}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex items-baseline justify-between border-t border-gray-200 pt-3">
              <span className="t-card-label text-ink-900">Total Refund Amount</span>
              <span className="t-cart-price text-green-600">
                {formatPaise(data.summary.refundedPaise)}
              </span>
            </div>
            {data.summary.pendingRefundPaise > 0 && (
              <p className="t-caption mt-1 text-gray-500">
                {formatPaise(data.summary.pendingRefundPaise)} still being processed
              </p>
            )}
            <Link
              href="/orders"
              className="t-btn mt-3 block rounded-lg border border-gray-300 py-2.5 text-center text-ink-900 transition hover:border-brand-600"
            >
              View Refund History
            </Link>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Quick Actions</h2>
            <ul className="mt-3 divide-y divide-gray-100">
              <li>
                <Link
                  href="/orders"
                  className="flex items-center gap-2.5 py-3 transition hover:text-brand-600"
                >
                  <ReturnIcon className="h-4 w-4 shrink-0 text-gray-500" />
                  <span className="min-w-0 flex-1">
                    <span className="t-card-label block text-ink-900">Request a Return</span>
                    <span className="t-caption block text-gray-500">
                      Return an item from recent orders
                    </span>
                  </span>
                  <span className="shrink-0 text-gray-300">›</span>
                </Link>
              </li>
              <li>
                <button
                  onClick={() => setFilter('REQUESTED')}
                  className="flex w-full items-center gap-2.5 py-3 text-left transition hover:text-brand-600"
                >
                  <ClockIcon className="h-4 w-4 shrink-0 text-gray-500" />
                  <span className="min-w-0 flex-1">
                    <span className="t-card-label block text-ink-900">Check Return Status</span>
                    <span className="t-caption block text-gray-500">Track your return status</span>
                  </span>
                  <span className="shrink-0 text-gray-300">›</span>
                </button>
              </li>
              <li>
                <Link
                  href="/pages/return-policy"
                  className="flex items-center gap-2.5 py-3 transition hover:text-brand-600"
                >
                  <ShieldCheckIcon className="h-4 w-4 shrink-0 text-gray-500" />
                  <span className="min-w-0 flex-1">
                    <span className="t-card-label block text-ink-900">View Return Policy</span>
                    <span className="t-caption block text-gray-500">Read our return policy</span>
                  </span>
                  <span className="shrink-0 text-gray-300">›</span>
                </Link>
              </li>
              <li>
                <Link
                  href="/account/help"
                  className="flex items-center gap-2.5 py-3 transition hover:text-brand-600"
                >
                  <HeadsetIcon className="h-4 w-4 shrink-0 text-gray-500" />
                  <span className="min-w-0 flex-1">
                    <span className="t-card-label block text-ink-900">Need Help?</span>
                    <span className="t-caption block text-gray-500">
                      Chat with our support team
                    </span>
                  </span>
                  <span className="shrink-0 text-gray-300">›</span>
                </Link>
              </li>
            </ul>
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
