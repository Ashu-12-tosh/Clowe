'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  COUPON_KIND_LABELS,
  type AuthUser,
  type CartView,
  type MyCoupon,
  type MyCouponStatus,
  type MyCouponsResponse,
  type ProductListItem,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser, setStoredUser } from '@/lib/api';
import { discountPercent, formatPaise } from '@/lib/format';
import { BADGES_EVENT } from '@/components/Header';
import {
  BoxIcon,
  HeadsetIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TagIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

const FILTERS = [
  { key: 'all', label: 'All Coupons' },
  { key: 'AVAILABLE', label: 'Available' },
  { key: 'USED', label: 'Used' },
  { key: 'EXPIRED', label: 'Expired' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns on eligible items' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

const STATUS_PILL: Record<MyCouponStatus, string> = {
  AVAILABLE: 'bg-brand-50 text-brand-700',
  USED: 'bg-gray-100 text-gray-600',
  EXPIRED: 'bg-red-50 text-red-600',
  LOCKED: 'bg-cream-200 text-gray-600',
};

/** Short headline: "₹150 OFF" / "15% OFF". */
function headline(coupon: MyCoupon): string {
  return coupon.type === 'FLAT' ? `${formatPaise(coupon.value)} OFF` : `${coupon.value}% OFF`;
}

/** Full sentence under the code. */
function detail(coupon: MyCoupon): string {
  if (coupon.description) return coupon.description;
  const cap = coupon.maxDiscountPaise ? ` up to ${formatPaise(coupon.maxDiscountPaise)}` : '';
  const min =
    coupon.minSubtotalPaise > 0
      ? ` on orders above ${formatPaise(coupon.minSubtotalPaise)}`
      : ' with no minimum order';
  return `${headline(coupon)}${cap}${min}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function HowToUse({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-3xl bg-white p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="How to use coupons"
      >
        <div className="flex items-center justify-between">
          <h2 className="t-sub-heading text-ink-900">How to use coupons</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-xl leading-none text-gray-400 hover:bg-gray-100"
          >
            ×
          </button>
        </div>
        <ol className="mt-4 space-y-3">
          {[
            'Tap Apply on any available coupon — we put it straight on your cart.',
            'Add enough to your cart to clear the coupon’s minimum order value.',
            'The discount shows in the order summary before you pay.',
            'Only one coupon applies per order; swap it any time from the cart.',
          ].map((line, i) => (
            <li key={line} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cream-100 text-xs font-bold text-ink-900">
                {i + 1}
              </span>
              <span className="t-body text-gray-600">{line}</span>
            </li>
          ))}
        </ol>
        <p className="t-caption mt-4 rounded-lg bg-cream-50 px-3 py-2 text-gray-500">
          Bank offers are applied by your bank on the payment page, not by Clowe.
        </p>
        <button
          onClick={onClose}
          className="t-btn mt-4 w-full rounded-lg bg-ink-900 py-3 text-white hover:bg-ink-800"
        >
          Got it
        </button>
      </div>
    </div>
  );
}

export default function CouponsPage() {
  const router = useRouter();
  const [data, setData] = useState<MyCouponsResponse | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [code, setCode] = useState('');
  const [busyCode, setBusyCode] = useState('');
  const [howOpen, setHowOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deals, setDeals] = useState<ProductListItem[]>([]);
  const [user, setUser] = useState<AuthUser | null>(null);

  const load = useCallback(() => {
    api<MyCouponsResponse>('/api/me/coupons', { auth: true })
      .then(setData)
      .catch(() => setError('Could not load your coupons'));
  }, []);

  useEffect(() => {
    setUser(getStoredUser());
    load();
    api<{ items: ProductListItem[] }>('/api/products?limit=6&sort=popularity')
      .then((r) => setDeals(r.items))
      .catch(() => {});
  }, [load]);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(''), 5000);
  }

  /** Apply a code to the cart, then send the shopper there to see it land. */
  async function apply(raw: string) {
    const value = raw.trim().toUpperCase();
    if (value.length < 3) {
      setError('Enter a coupon code');
      return;
    }
    setError('');
    setBusyCode(value);
    try {
      const cart = await api<CartView>('/api/cart/coupon', {
        method: 'POST',
        body: { code: value },
        auth: true,
      });
      window.dispatchEvent(new Event(BADGES_EVENT));
      setCode('');
      flash(
        `${value} applied — you save ${formatPaise(cart.couponDiscountPaise)} on this cart.`,
      );
      setTimeout(() => router.push('/cart'), 900);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not apply that coupon');
    } finally {
      setBusyCode('');
    }
  }

  async function enableAlerts() {
    try {
      const fresh = await api<AuthUser>('/api/auth/me/preferences', {
        method: 'PATCH',
        body: { email: true, sms: true, whatsapp: true },
        auth: true,
      });
      setStoredUser(fresh);
      setUser(fresh);
      flash('Coupon alerts turned on for email, SMS and WhatsApp.');
    } catch {
      setError('Could not update your notification preferences');
    }
  }

  const visible = useMemo(() => {
    const rows = data?.coupons ?? [];
    if (filter === 'all') return rows;
    return rows.filter((c) => c.status === filter);
  }, [data, filter]);

  const countFor = (key: FilterKey) =>
    key === 'all'
      ? (data?.coupons.length ?? 0)
      : (data?.coupons.filter((c) => c.status === key).length ?? 0);

  const alertsOn = user?.prefs
    ? user.prefs.email || user.prefs.sms || user.prefs.whatsapp
    : false;

  if (!data) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-12 w-64 rounded-lg bg-cream-100" />
        <div className="h-96 rounded-2xl bg-cream-100" />
      </div>
    );
  }

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
        <span className="font-medium text-ink-900">My Coupons</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-page-title text-ink-900">
            My Coupons{' '}
            <span className="t-caption font-normal text-gray-500">({data.summary.total})</span>
          </h1>
          <p className="t-section-desc mt-1 text-gray-500">
            Save more with exclusive coupons and offers.
          </p>
        </div>
        <button
          onClick={() => setHowOpen(true)}
          className="t-btn rounded-lg border border-gray-300 px-4 py-2.5 text-ink-900 transition hover:border-brand-600 hover:text-brand-600"
        >
          ❓ How to Use Coupons
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

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {/* Filters + manual code */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((item) => (
                <button
                  key={item.key}
                  onClick={() => setFilter(item.key)}
                  className={`t-btn rounded-full px-4 py-2 transition ${
                    filter === item.key
                      ? 'bg-ink-900 text-white'
                      : 'border border-gray-300 text-gray-600 hover:border-ink-900'
                  }`}
                >
                  {item.label} ({countFor(item.key)})
                </button>
              ))}
            </div>

            <label className="t-caption text-gray-600">
              Enter Coupon Code
              <span className="mt-1 flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && void apply(code)}
                  placeholder="Enter code"
                  aria-label="Coupon code"
                  className="t-body w-40 rounded-lg border border-gray-300 px-3 py-2 uppercase tracking-wide outline-none focus:border-brand-600"
                />
                <button
                  onClick={() => void apply(code)}
                  disabled={busyCode !== ''}
                  className="t-btn rounded-lg bg-ink-900 px-5 text-white transition hover:bg-ink-800 disabled:opacity-50"
                >
                  Apply
                </button>
              </span>
            </label>
          </div>

          {/* Coupon list */}
          {visible.length === 0 ? (
            <div className="rounded-2xl border border-gray-100 bg-white py-16 text-center">
              <span className="text-4xl">🎟</span>
              <p className="t-body mt-3 text-gray-500">
                {filter === 'all'
                  ? 'No coupons right now — check back soon.'
                  : `No ${filter.toLowerCase()} coupons.`}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {visible.map((coupon) => {
                const usable = coupon.status === 'AVAILABLE';
                const kindLabel = COUPON_KIND_LABELS[coupon.kind];
                return (
                  <li
                    key={coupon.code}
                    className={`flex flex-wrap items-stretch overflow-hidden rounded-2xl border bg-white ${
                      usable ? 'border-gray-100' : 'border-gray-100 opacity-80'
                    }`}
                  >
                    {/* Code tile */}
                    <div
                      className={`flex w-full flex-col items-center justify-center px-5 py-4 text-center sm:w-40 ${
                        coupon.status === 'EXPIRED'
                          ? 'bg-gray-400 text-white'
                          : coupon.status === 'USED'
                            ? 'bg-brand-500 text-white'
                            : 'bg-ink-950 text-white'
                      }`}
                    >
                      <span className="t-card-label tracking-widest">{coupon.code}</span>
                      <span className="t-sub-heading text-brand-400">{headline(coupon)}</span>
                    </div>

                    {/* Body */}
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4 px-5 py-4">
                      <div className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`t-badge rounded px-2 py-0.5 uppercase ${STATUS_PILL[coupon.status]}`}
                          >
                            {coupon.status}
                          </span>
                          {kindLabel && (
                            <span className="t-badge rounded bg-blue-50 px-2 py-0.5 uppercase text-blue-700">
                              {kindLabel}
                            </span>
                          )}
                        </span>
                        <p className="t-card-label mt-1.5 text-ink-900">{detail(coupon)}</p>
                        <p className="t-caption mt-0.5 text-gray-500">
                          {coupon.status === 'USED' && coupon.lastUsedAt
                            ? `Used on ${fmtDate(coupon.lastUsedAt)}`
                            : coupon.status === 'EXPIRED' && coupon.expiresAt
                              ? `Expired on ${fmtDate(coupon.expiresAt)}`
                              : coupon.lockedReason
                                ? coupon.lockedReason
                                : coupon.expiresAt
                                  ? `Valid till ${fmtDate(coupon.expiresAt)}`
                                  : 'No expiry'}
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        <p className="t-caption text-gray-500">Min. Order</p>
                        <p className="t-card-label text-ink-900">
                          {coupon.minSubtotalPaise > 0
                            ? formatPaise(coupon.minSubtotalPaise)
                            : 'None'}
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        {usable ? (
                          <button
                            onClick={() => void apply(coupon.code)}
                            disabled={busyCode === coupon.code}
                            className="t-btn rounded-lg bg-ink-900 px-6 py-2.5 text-white transition hover:bg-ink-800 disabled:opacity-50"
                          >
                            {busyCode === coupon.code ? 'Applying…' : 'Apply'}
                          </button>
                        ) : (
                          <span className="t-btn inline-block rounded-lg border border-gray-300 px-6 py-2.5 text-gray-400">
                            {coupon.status === 'USED'
                              ? '✓ Used'
                              : coupon.status === 'EXPIRED'
                                ? '⊗ Expired'
                                : '🔒 Locked'}
                          </span>
                        )}
                        <p className="t-caption mt-1 text-gray-400">*T&amp;C Apply</p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Alerts banner */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-brand-50/70 px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎟</span>
              <div>
                <p className="t-card-label text-ink-900">Exclusive Coupons Just for You!</p>
                <p className="t-caption text-gray-600">
                  {alertsOn
                    ? 'Coupon alerts are on — we’ll tell you about new offers.'
                    : 'Allow notifications to get instant alerts on new coupons and big savings.'}
                </p>
              </div>
            </div>
            {alertsOn ? (
              <Link
                href="/notifications"
                className="t-btn rounded-lg border border-brand-600 px-4 py-2.5 text-brand-700 transition hover:bg-brand-50"
              >
                Manage alerts
              </Link>
            ) : (
              <button
                onClick={() => void enableAlerts()}
                className="t-btn rounded-lg bg-brand-600 px-4 py-2.5 text-white transition hover:bg-brand-700"
              >
                🔔 Enable Notifications
              </button>
            )}
          </div>
        </div>

        {/* ── Right rail ─────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Coupons Summary</h2>
            <dl className="mt-3 space-y-2.5">
              {[
                { label: 'Total Coupons', value: data.summary.total },
                { label: 'Available', value: data.summary.available },
                { label: 'Used', value: data.summary.used },
                { label: 'Expired', value: data.summary.expired },
              ].map((row) => (
                <div key={row.label} className="flex justify-between">
                  <dt className="t-caption text-gray-600">{row.label}</dt>
                  <dd className="t-card-label text-ink-900">{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex items-baseline justify-between border-t border-gray-200 pt-3">
              <span className="t-card-label text-ink-900">
                Total Savings
                <span className="t-caption block font-normal text-gray-400">(till now)</span>
              </span>
              <span className="t-cart-price text-green-600">
                {formatPaise(data.summary.totalSavingsPaise)}
              </span>
            </div>
            <Link
              href="/orders"
              className="t-btn mt-3 block rounded-lg border border-gray-300 py-2.5 text-center text-ink-900 transition hover:border-brand-600"
            >
              View Savings History
            </Link>
          </div>

          {deals.length > 0 && (
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="t-sub-heading text-ink-900">Best Deals For You</h2>
              <ul className="mt-3 space-y-3">
                {deals.slice(0, 3).map((product) => {
                  const off = discountPercent(product.pricePaise, product.mrpPaise);
                  return (
                    <li key={product.id} className="flex items-start gap-3">
                      <Link href={`/products/${product.slug}`} className="shrink-0">
                        {product.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={product.imageUrl}
                            alt=""
                            loading="lazy"
                            className="h-14 w-14 rounded-lg bg-cream-100 object-cover"
                          />
                        ) : (
                          <div className="h-14 w-14 rounded-lg bg-cream-100" />
                        )}
                      </Link>
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/products/${product.slug}`}
                          className="t-caption line-clamp-2 font-semibold text-ink-900 hover:text-brand-600"
                        >
                          {product.title}
                        </Link>
                        <p className="t-caption mt-0.5 flex flex-wrap items-baseline gap-1.5">
                          <span className="font-bold text-ink-900">
                            {formatPaise(product.pricePaise)}
                          </span>
                          {product.mrpPaise && off !== null && (
                            <>
                              <span className="text-gray-400 line-through">
                                {formatPaise(product.mrpPaise)}
                              </span>
                              <span className="font-bold text-brand-600">{off}% OFF</span>
                            </>
                          )}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <Link
                href="/products?sort=popularity"
                className="t-btn mt-3 block rounded-lg border border-gray-300 py-2.5 text-center text-ink-900 transition hover:border-brand-600"
              >
                View More Offers
              </Link>
            </div>
          )}

          <div className="flex items-start gap-2.5 rounded-2xl border border-gray-100 bg-white p-4">
            <TagIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
            <p className="t-caption text-gray-600">
              One coupon applies per order. Applying a new code replaces the one on your cart.
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

      {howOpen && <HowToUse onClose={() => setHowOpen(false)} />}
    </div>
  );
}
