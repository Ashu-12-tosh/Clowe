'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthUser, OrderDetailView, ProductListItem } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { fetchWishlistIds } from '@/lib/wishlist';
import { Scroller } from '@/components/home/HomeBits';
import ProductCard from '@/components/ProductCard';
import {
  BoxIcon,
  CardIcon,
  CheckIcon,
  HeadsetIcon,
  MapPinIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

/** The delivery journey, in the order it happens. */
const STEPS = [
  { key: 'PLACED', label: 'Order Placed', icon: CheckIcon },
  { key: 'CONFIRMED', label: 'Confirmed', icon: BoxIcon },
  { key: 'SHIPPED', label: 'Shipped', icon: TruckIcon },
  { key: 'OUT_FOR_DELIVERY', label: 'Out for Delivery', icon: TruckIcon },
  { key: 'DELIVERED', label: 'Delivered', icon: CheckIcon },
] as const;

const HAPPINESS = [
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'On eligible items' },
  { Icon: BoxIcon, title: '100% Original', text: 'Products' },
  { Icon: ShieldCheckIcon, title: 'Secure', text: 'Payments' },
  { Icon: HeadsetIcon, title: '24/7', text: 'Customer Support' },
];

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns on eligible items' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
function fmtShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
function etaLabel(from: string | null, to: string | null): string | null {
  if (!to) return null;
  if (!from || fmtShort(from) === fmtShort(to)) return fmtShort(to);
  return `${fmtShort(from)} – ${fmtShort(to)}`;
}
/** Day offset from the quoted delivery window, for the middle steps. */
function daysBefore(iso: string | null, days: number): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  date.setDate(date.getDate() - days);
  return fmtShort(date.toISOString());
}

/** How far along the journey this order is. */
function reachedIndex(status: string): number {
  switch (status) {
    case 'DELIVERED':
    case 'RETURN_REQUESTED':
    case 'RETURNED':
      return 4;
    case 'SHIPPED':
      return 2;
    case 'PACKED':
    case 'CONFIRMED':
      return 1;
    default:
      return 0; // PLACED / CANCELLED
  }
}

export default function OrderConfirmationPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetailView | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [suggestions, setSuggestions] = useState<ProductListItem[]>([]);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!getStoredUser()) {
      router.replace('/login');
      return;
    }
    setUser(getStoredUser());
    api<OrderDetailView>(`/api/orders/${params.id}`, { auth: true })
      .then(setOrder)
      .catch(() => setNotFound(true));
    api<{ items: ProductListItem[] }>('/api/products?limit=12&sort=popularity')
      .then((data) => setSuggestions(data.items))
      .catch(() => {});
    fetchWishlistIds().then(setWishlistIds);
  }, [params.id, router]);

  if (notFound) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <h1 className="t-page-title text-ink-900">Order not found</h1>
        <Link
          href="/orders"
          className="t-btn mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-white hover:bg-ink-800"
        >
          My Orders
        </Link>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="mx-auto max-w-7xl animate-pulse px-4 py-6">
        <div className="h-40 rounded-2xl bg-cream-100" />
        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="h-80 rounded-2xl bg-cream-100" />
          <div className="h-72 rounded-2xl bg-cream-100" />
        </div>
      </main>
    );
  }

  const reached = reachedIndex(order.status);
  const cancelled = order.status === 'CANCELLED';
  const eta = etaLabel(order.etaFrom, order.etaTo);
  const orderedIds = order.items.map((i) => i.productSlug);
  const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
  const paymentLabel =
    order.payment?.provider === 'mock' ? 'Mock gateway (dev)' : (order.payment?.provider ?? '—');

  /** Date shown under each step: real for what happened, expected for the rest. */
  const stepDates: (string | null)[] = [
    fmtDateTime(order.createdAt),
    order.payment?.paidAt ? fmtDateTime(order.payment.paidAt) : 'Processing your order',
    daysBefore(order.etaFrom, 1) && `Expected by ${daysBefore(order.etaFrom, 1)}`,
    order.etaFrom && `Expected by ${fmtShort(order.etaFrom)}`,
    order.etaTo && `Expected by ${fmtShort(order.etaTo)}`,
  ];

  return (
    <main className="mx-auto max-w-7xl px-4 pb-10 pt-4">
      {/* ── Success banner ─────────────────────────────────────────────── */}
      <section className="grid gap-5 rounded-2xl border border-gray-100 bg-white p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:p-6">
        <div className="flex items-start gap-4">
          <span
            className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full ${
              cancelled ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'
            }`}
          >
            {cancelled ? <span className="text-2xl">✕</span> : <CheckIcon className="h-8 w-8" />}
          </span>
          <div className="min-w-0">
            <h1 className="t-page-title text-ink-900">
              {cancelled ? 'Order cancelled' : `Thank you, ${user?.name?.split(' ')[0] ?? 'there'}!`}
            </h1>
            <p
              className={`t-sub-heading mt-1 ${cancelled ? 'text-red-600' : 'text-green-600'}`}
            >
              {cancelled
                ? 'This order was cancelled.'
                : 'Your order has been placed successfully.'}
            </p>
            {!cancelled && (
              <p className="t-caption mt-2 text-gray-500">
                We&apos;ve sent an order confirmation to
                <br />
                <span className="font-semibold text-ink-900">
                  {user?.email ?? 'your account'}
                </span>{' '}
                and <span className="font-semibold text-ink-900">+91 {order.shipTo.phone}</span>
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={`/account/orders/${order.id}`}
                className="t-btn rounded-lg bg-ink-900 px-5 py-2.5 text-white transition hover:bg-ink-800"
              >
                View Order Details ›
              </Link>
              <Link
                href="/products"
                className="t-btn rounded-lg border border-gray-300 px-5 py-2.5 text-ink-900 transition hover:border-brand-600"
              >
                Continue Shopping
              </Link>
            </div>
          </div>
        </div>

        <div className="lg:border-l lg:border-gray-100 lg:pl-6">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: 'Order ID', value: order.orderNumber },
              { label: 'Order Date', value: fmtDateTime(order.createdAt) },
              { label: 'Payment Method', value: paymentLabel },
              { label: 'Total Paid', value: formatPaise(order.totalPaise) },
            ].map((row) => (
              <div key={row.label}>
                <dt className="t-caption text-gray-500">{row.label}</dt>
                <dd className="t-card-label mt-0.5 break-words text-ink-900">{row.value}</dd>
              </div>
            ))}
          </dl>

          {eta && !cancelled && (
            <div className="mt-4 flex items-start gap-3 rounded-xl bg-green-50 px-4 py-3">
              <TruckIcon className="mt-0.5 h-5 w-5 shrink-0 text-green-700" />
              <div>
                <p className="t-card-label text-ink-900">Estimated Delivery: {eta}</p>
                <p className="t-caption text-gray-600">
                  We will notify you once your items are shipped.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          {/* ── Tracking ─────────────────────────────────────────────── */}
          {!cancelled && (
            <section className="rounded-2xl border border-gray-100 bg-white p-5">
              <h2 className="t-sub-heading text-ink-900">Order Tracking</h2>

              <ol className="mt-5 flex items-start">
                {STEPS.map((step, i) => {
                  const done = i <= reached;
                  const active = i === reached;
                  const Icon = step.icon;
                  return (
                    <li key={step.key} className="flex flex-1 flex-col items-center last:flex-none">
                      <div className="flex w-full items-center">
                        <span
                          className={`h-0.5 flex-1 ${
                            i === 0 ? 'bg-transparent' : done ? 'bg-brand-600' : 'bg-gray-200'
                          }`}
                        />
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 ${
                            active
                              ? 'border-brand-600 bg-white text-brand-600'
                              : done
                                ? 'border-green-600 bg-green-600 text-white'
                                : 'border-gray-200 bg-white text-gray-300'
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <span
                          className={`h-0.5 flex-1 ${
                            i === STEPS.length - 1
                              ? 'bg-transparent'
                              : i < reached
                                ? 'bg-brand-600'
                                : 'bg-gray-200'
                          }`}
                        />
                      </div>
                      <p
                        className={`t-caption mt-2 text-center font-semibold ${
                          done ? 'text-ink-900' : 'text-gray-400'
                        }`}
                      >
                        {step.label}
                      </p>
                      {stepDates[i] && (
                        <p className="t-caption text-center text-gray-400">{stepDates[i]}</p>
                      )}
                    </li>
                  );
                })}
              </ol>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-50/60 px-4 py-3">
                <p className="t-caption flex items-center gap-2 text-gray-700">
                  🔔 We will notify you at every step of the delivery.
                </p>
                <p className="t-caption text-gray-600">
                  You can track your order anytime from{' '}
                  <Link href="/orders" className="font-semibold text-brand-600 hover:underline">
                    My Orders ›
                  </Link>
                </p>
              </div>
            </section>
          )}

          {/* ── Address / payment / help ─────────────────────────────── */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              <p className="t-card-label flex items-center gap-2 text-ink-900">
                <CardIcon className="h-4 w-4 text-gray-500" />
                Payment Details
              </p>
              <p className="t-card-label mt-3 text-ink-900">
                {order.payment?.status === 'PAID' ? `Paid via ${paymentLabel}` : 'Payment pending'}
              </p>
              {order.payment?.transactionId && (
                <p className="t-caption mt-1 break-all text-gray-500">
                  Transaction ID: {order.payment.transactionId}
                </p>
              )}
              {order.payment?.paidAt && (
                <p className="t-caption mt-1 text-gray-500">{fmtDateTime(order.payment.paidAt)}</p>
              )}
              <Link
                href={`/account/orders/${order.id}`}
                className="t-caption mt-3 block rounded-lg border border-gray-300 py-2 text-center font-bold text-ink-900 transition hover:bg-cream-50"
              >
                View Payment Details
              </Link>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <p className="t-card-label flex items-center gap-2 text-ink-900">
                <HeadsetIcon className="h-4 w-4 text-gray-500" />
                Need Help?
              </p>
              <p className="t-caption mt-3 text-center text-gray-500">We are here for you 24/7</p>
              <Link
                href="/pages/help"
                className="t-card-label mt-3 flex items-center justify-between border-t border-gray-100 pt-3 text-ink-900 hover:text-brand-600"
              >
                ❓ Help Center <span className="text-gray-300">›</span>
              </Link>
              <Link
                href="/complaints"
                className="t-card-label mt-2 flex items-center justify-between border-t border-gray-100 pt-3 text-ink-900 hover:text-brand-600"
              >
                💬 Raise a complaint <span className="text-gray-300">›</span>
              </Link>
            </div>
          </div>

          {/* ── Suggestions ──────────────────────────────────────────── */}
          {suggestions.filter((p) => !orderedIds.includes(p.slug)).length > 0 && (
            <section className="rounded-2xl border border-gray-100 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="t-sub-heading text-ink-900">You may also like</h2>
                <Link href="/products" className="t-caption font-semibold text-brand-600 hover:underline">
                  View All ›
                </Link>
              </div>
              <div className="mt-3">
                <Scroller>
                  {suggestions
                    .filter((p) => !orderedIds.includes(p.slug))
                    .slice(0, 10)
                    .map((product) => (
                      <div key={product.id} className="w-36 shrink-0 sm:w-40">
                        <ProductCard product={product} inWishlist={wishlistIds.has(product.id)} />
                      </div>
                    ))}
                </Scroller>
              </div>
            </section>
          )}
        </div>

        {/* ── Right column ───────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="t-sub-heading text-ink-900">
                Order Summary{' '}
                <span className="t-caption font-normal text-gray-500">({itemCount} Items)</span>
              </h2>
              <Link
                href={`/account/orders/${order.id}`}
                className="t-caption font-semibold text-brand-600 hover:underline"
              >
                View Details
              </Link>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {order.items.slice(0, 5).map((item) =>
                item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={item.id}
                    src={item.imageUrl}
                    alt={item.title}
                    title={item.title}
                    loading="lazy"
                    className="h-14 w-12 rounded-lg bg-cream-100 object-cover"
                  />
                ) : (
                  <div key={item.id} className="h-14 w-12 rounded-lg bg-cream-100" />
                ),
              )}
              {order.items.length > 5 && (
                <span className="t-card-label flex h-14 w-12 items-center justify-center rounded-lg bg-cream-100 text-gray-500">
                  +{order.items.length - 5}
                </span>
              )}
            </div>

            <dl className="mt-4 space-y-2 border-t border-gray-100 pt-3">
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Item Total ({itemCount} Items)</dt>
                <dd className="t-card-label text-ink-900">{formatPaise(order.subtotalPaise)}</dd>
              </div>
              {order.couponDiscountPaise > 0 && (
                <div className="flex justify-between">
                  <dt className="t-caption text-gray-600">
                    Discount{' '}
                    <span className="font-semibold text-brand-600">({order.couponCode})</span>
                  </dt>
                  <dd className="t-card-label text-green-600">
                    −{formatPaise(order.couponDiscountPaise)}
                  </dd>
                </div>
              )}
              {order.creditsUsed > 0 && (
                <div className="flex justify-between">
                  <dt className="t-caption text-gray-600">Clowe Credits ({order.creditsUsed} 🪙)</dt>
                  <dd className="t-card-label text-green-600">
                    −{formatPaise(order.discountPaise - order.couponDiscountPaise)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Shipping Charges</dt>
                <dd
                  className={`t-card-label ${
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
          </div>

          {/* Happiness */}
          <div className="rounded-2xl border border-gray-100 bg-cream-50 p-4">
            <p className="t-card-label text-ink-900">We&apos;re committed to your happiness!</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {HAPPINESS.map(({ Icon, title, text }) => (
                <div key={title} className="flex items-start gap-2">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                  <div className="min-w-0">
                    <p className="t-caption font-bold text-ink-900">{title}</p>
                    <p className="t-caption text-gray-500">{text}</p>
                  </div>
                </div>
              ))}
            </div>
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
