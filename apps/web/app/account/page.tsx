'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AccountOverview } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import {
  BoxIcon,
  CardIcon,
  HeadsetIcon,
  MapPinIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TagIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

const TRUST_STRIP = [
  { Icon: BoxIcon, title: 'Free Shipping', text: 'On orders above ₹999' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: '7 days return policy' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure' },
  { Icon: HeadsetIcon, title: '24x7 Support', text: 'We are here for you' },
];

const PREMIUM_BENEFITS = [
  { Icon: TruckIcon, title: 'Free Delivery', text: 'Unlimited free standard delivery' },
  { Icon: TagIcon, title: 'Exclusive Offers', text: 'Member-only coupons' },
  { Icon: BoxIcon, title: 'Early Access', text: 'Shop sales before everyone' },
  { Icon: HeadsetIcon, title: 'Priority Support', text: '24x7 priority help' },
];

const STATUS_STYLES: Record<string, string> = {
  PLACED: 'bg-blue-50 text-blue-700',
  CONFIRMED: 'bg-blue-50 text-blue-700',
  PACKED: 'bg-indigo-50 text-indigo-700',
  SHIPPED: 'bg-purple-50 text-purple-700',
  DELIVERED: 'bg-green-50 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-50 text-orange-700',
  RETURNED: 'bg-orange-50 text-orange-700',
};

function statusLabel(status: string): string {
  return status
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function AccountOverviewPage() {
  const [data, setData] = useState<AccountOverview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<AccountOverview>('/api/me/overview', { auth: true })
      .then(setData)
      .catch(() => setError('Could not load your account'));
  }, []);

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-20 rounded-2xl bg-cream-100" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 rounded-2xl bg-cream-100" />
          ))}
        </div>
        <div className="h-72 rounded-2xl bg-cream-100" />
      </div>
    );
  }

  const firstName = data.profile.name?.split(' ')[0] ?? 'there';
  const stats = [
    { label: 'Orders', value: String(data.stats.orders), href: '/account/orders', icon: '📦' },
    { label: 'Wishlist', value: String(data.stats.wishlist), href: '/wishlist', icon: '♡' },
    {
      label: 'Clowe Wallet',
      value: formatPaise(data.stats.walletPaise),
      href: '/account/credits',
      icon: '👛',
    },
    { label: 'Coupons', value: String(data.stats.coupons), href: '/account/coupons', icon: '🎟' },
  ];

  return (
    <div className="space-y-4">
      {/* Greeting */}
      <div>
        <h1 className="t-page-title text-ink-900">Welcome back, {firstName}! 👋</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage your account, orders and preferences all in one place.
        </p>
      </div>

      {/* Premium banner / upsell */}
      {data.profile.isPremium ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-ink-950 px-5 py-4 text-white">
          <div className="flex items-center gap-3">
            <span className="text-2xl text-brand-400">♛</span>
            <div>
              <p className="text-sm font-bold">Premium Member</p>
              <p className="text-xs text-gray-400">
                You are enjoying unlimited free delivery and exclusive offers.
              </p>
            </div>
          </div>
          <Link
            href="/pages/help"
            className="rounded-lg border border-brand-500 px-4 py-2 text-xs font-bold text-brand-400 transition hover:bg-brand-600 hover:text-white"
          >
            View Benefits
          </Link>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-cream-50 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl text-brand-500">♛</span>
            <div>
              <p className="text-sm font-bold text-ink-900">Clowe Premium</p>
              <p className="text-xs text-gray-500">
                Unlimited free delivery, exclusive offers and early access to sales.
              </p>
            </div>
          </div>
          <Link
            href="/pages/help"
            className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-brand-700"
          >
            Explore Premium
          </Link>
        </div>
      )}

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((tile) => (
          <Link
            key={tile.label}
            href={tile.href}
            className="group rounded-2xl border border-gray-100 bg-white p-4 transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs text-gray-500">{tile.label}</p>
                <p className="t-kpi mt-1 text-ink-900">{tile.value}</p>
              </div>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cream-100 text-lg">
                {tile.icon}
              </span>
            </div>
            <p className="mt-2 text-xs font-semibold text-brand-600 group-hover:underline">
              View all →
            </p>
          </Link>
        ))}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Recent orders */}
        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-bold text-ink-900">Recent Orders</h2>
            <Link href="/account/orders" className="text-xs font-semibold text-brand-600 hover:underline">
              View All Orders →
            </Link>
          </div>

          {data.recentOrders.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-gray-500">You haven&apos;t placed an order yet.</p>
              <Link
                href="/products"
                className="mt-4 inline-block rounded-lg bg-ink-900 px-6 py-2.5 text-sm font-bold text-white hover:bg-ink-800"
              >
                Start Shopping
              </Link>
            </div>
          ) : (
            <>
              <ul className="mt-3 divide-y divide-gray-100">
                {data.recentOrders.map((order) => (
                  <li key={order.id}>
                    <Link
                      href={`/account/orders/${order.id}`}
                      className="flex items-center gap-3 py-3 transition hover:bg-cream-50"
                    >
                      {order.previewImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={order.previewImageUrl}
                          alt=""
                          loading="lazy"
                          className="h-14 w-12 shrink-0 rounded-lg bg-cream-100 object-cover"
                        />
                      ) : (
                        <div className="h-14 w-12 shrink-0 rounded-lg bg-cream-100" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink-900">
                          Order #{order.orderNumber}
                        </p>
                        <p className="mt-0.5 text-xs text-gray-500">
                          Placed on {formatDate(order.createdAt)}
                        </p>
                      </div>
                      <div className="hidden shrink-0 text-right sm:block">
                        <p className="text-sm font-bold text-ink-900">
                          {formatPaise(order.totalPaise)}
                        </p>
                        <p className="text-xs text-gray-500">
                          {order.itemCount} Item{order.itemCount === 1 ? '' : 's'}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-bold ${
                          STATUS_STYLES[order.status] ?? 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {statusLabel(order.status)}
                      </span>
                      <span className="shrink-0 text-gray-300">›</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <Link
                href="/account/orders"
                className="mt-3 block rounded-lg border border-gray-300 py-2.5 text-center text-sm font-bold text-ink-900 transition hover:bg-cream-50"
              >
                View All Orders
              </Link>
            </>
          )}
        </section>

        {/* Right column */}
        <div className="space-y-4">
          {/* Default address */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-bold text-ink-900">Default Shipping Address</h2>
              <Link
                href="/account/addresses"
                className="text-xs font-semibold text-brand-600 hover:underline"
              >
                Manage
              </Link>
            </div>
            {data.defaultAddress ? (
              <div className="mt-3">
                <p className="flex items-center gap-1.5 text-sm font-bold text-ink-900">
                  <MapPinIcon className="h-4 w-4 text-gray-500" />
                  {data.defaultAddress.label.charAt(0) +
                    data.defaultAddress.label.slice(1).toLowerCase()}
                  <span className="ml-auto text-brand-500">★</span>
                </p>
                <p className="mt-2 text-sm font-semibold text-ink-900">{data.defaultAddress.name}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
                  {data.defaultAddress.line1}
                  {data.defaultAddress.line2 ? `, ${data.defaultAddress.line2}` : ''}
                  <br />
                  {data.defaultAddress.city}, {data.defaultAddress.state} -{' '}
                  {data.defaultAddress.pincode}
                </p>
                <p className="mt-1 text-xs text-gray-500">+91 {data.defaultAddress.phone}</p>
                <Link
                  href="/account/addresses"
                  className="mt-3 block rounded-lg border border-gray-300 py-2 text-center text-xs font-bold text-ink-900 transition hover:bg-cream-50"
                >
                  Edit Address
                </Link>
              </div>
            ) : (
              <div className="mt-3">
                <p className="text-xs text-gray-500">No address saved yet.</p>
                <Link
                  href="/account/addresses"
                  className="mt-3 block rounded-lg bg-ink-900 py-2 text-center text-xs font-bold text-white hover:bg-ink-800"
                >
                  Add Address
                </Link>
              </div>
            )}
          </div>

          {/* Payment methods */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-bold text-ink-900">Payment Methods</h2>
              <Link
                href="/account/payments"
                className="text-xs font-semibold text-brand-600 hover:underline"
              >
                Manage
              </Link>
            </div>
            {data.paymentMethods.length === 0 ? (
              <p className="mt-3 text-xs text-gray-500">No saved payment methods.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.paymentMethods.slice(0, 3).map((method) => (
                  <li
                    key={method.id}
                    className="flex items-center gap-2.5 rounded-lg border border-gray-100 px-3 py-2"
                  >
                    <CardIcon className="h-4 w-4 shrink-0 text-gray-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-ink-900">
                        {method.brand}{' '}
                        {method.kind === 'CARD' ? `•••• ${method.label}` : method.label}
                      </p>
                      {method.expiryMonth && method.expiryYear && (
                        <p className="text-[11px] text-gray-500">
                          Expires {String(method.expiryMonth).padStart(2, '0')}/
                          {String(method.expiryYear).slice(-2)}
                        </p>
                      )}
                    </div>
                    {method.isDefault && (
                      <span className="shrink-0 rounded border border-brand-200 px-1.5 py-0.5 text-[10px] font-bold text-brand-700">
                        Default
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/account/payments"
              className="mt-3 block text-xs font-semibold text-brand-600 hover:underline"
            >
              + Add New Card
            </Link>
          </div>

          {/* Recently viewed */}
          {data.recentlyViewed.length > 0 && (
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-bold text-ink-900">Recently Viewed</h2>
                <Link
                  href="/account/recently-viewed"
                  className="text-xs font-semibold text-brand-600 hover:underline"
                >
                  View All
                </Link>
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {data.recentlyViewed.slice(0, 4).map((product) => (
                  <Link key={product.id} href={`/products/${product.slug}`} className="group">
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={product.imageUrl}
                        alt={product.title}
                        loading="lazy"
                        className="aspect-square w-full rounded-lg bg-cream-100 object-cover"
                      />
                    ) : (
                      <div className="aspect-square w-full rounded-lg bg-cream-100" />
                    )}
                    <p className="mt-1 truncate text-[11px] font-semibold text-ink-900 group-hover:text-brand-600">
                      {formatPaise(product.pricePaise)}
                    </p>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Trust strip */}
      <section className="grid gap-4 rounded-2xl border border-gray-100 bg-white p-5 sm:grid-cols-2 lg:grid-cols-4">
        {TRUST_STRIP.map(({ Icon, title, text }) => (
          <div key={title} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-ink-900">{title}</p>
              <p className="text-xs text-gray-500">{text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Premium footer banner */}
      <section className="overflow-hidden rounded-2xl bg-ink-950 p-5 text-white">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-center">
          <div>
            <p className="font-display text-xl font-bold text-brand-400">♛ CLOWE PREMIUM</p>
            <p className="mt-2 text-sm text-gray-300">
              Enjoy unlimited free delivery, exclusive offers and early access to sales.
            </p>
            {!data.profile.isPremium && (
              <Link
                href="/pages/help"
                className="mt-4 inline-block rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-700"
              >
                Explore Premium Benefits
              </Link>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PREMIUM_BENEFITS.map(({ Icon, title, text }) => (
              <div key={title} className="flex items-start gap-2.5">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-400" />
                <div className="min-w-0">
                  <p className="text-xs font-bold">{title}</p>
                  <p className="text-[11px] text-gray-400">{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
