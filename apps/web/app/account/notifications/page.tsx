'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_CTA_LABELS,
  type AuthUser,
  type NotificationCategory,
  type NotificationList,
  type NotificationRow,
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

/** Icon + tint per notification type — falls back to the category. */
const TYPE_ICON: Record<string, { icon: string; tint: string }> = {
  ORDER_CONFIRMED: { icon: '🎉', tint: 'bg-green-50 text-green-700' },
  ITEM_SHIPPED: { icon: '🚚', tint: 'bg-blue-50 text-blue-700' },
  ITEM_PACKED: { icon: '📦', tint: 'bg-indigo-50 text-indigo-700' },
  ITEM_DELIVERED: { icon: '✓', tint: 'bg-green-50 text-green-700' },
  RETURN_REQUESTED: { icon: '↩', tint: 'bg-orange-50 text-orange-700' },
  RETURN_APPROVED: { icon: '↩', tint: 'bg-blue-50 text-blue-700' },
  RETURN_REJECTED: { icon: '⊗', tint: 'bg-red-50 text-red-600' },
  RETURN_RECEIVED: { icon: '📦', tint: 'bg-purple-50 text-purple-700' },
  REFUND_INITIATED: { icon: '💸', tint: 'bg-brand-50 text-brand-700' },
  REFUND_PROCESSED: { icon: '💸', tint: 'bg-green-50 text-green-700' },
  CREDITS_EARNED: { icon: '🪙', tint: 'bg-brand-50 text-brand-700' },
  REFERRAL_CREDITED: { icon: '🎁', tint: 'bg-brand-50 text-brand-700' },
  COMPLAINT_REGISTERED: { icon: '📢', tint: 'bg-orange-50 text-orange-700' },
  COMPLAINT_UPDATED: { icon: '📢', tint: 'bg-blue-50 text-blue-700' },
  PHONE_CHANGED: { icon: '🛡', tint: 'bg-red-50 text-red-600' },
  NEW_ORDER: { icon: '🛍', tint: 'bg-blue-50 text-blue-700' },
  PAYOUT_SENT: { icon: '💸', tint: 'bg-brand-50 text-brand-700' },
  SUPPORT_REPLY: { icon: '💬', tint: 'bg-blue-50 text-blue-700' },
  SUPPORT_RESOLVED: { icon: '✓', tint: 'bg-green-50 text-green-700' },
};
const CATEGORY_ICON: Record<NotificationCategory, { icon: string; tint: string }> = {
  ORDERS: { icon: '📦', tint: 'bg-blue-50 text-blue-700' },
  OFFERS: { icon: '🏷', tint: 'bg-brand-50 text-brand-700' },
  ACCOUNT: { icon: '👤', tint: 'bg-cream-200 text-ink-900' },
  SELLER: { icon: '🏪', tint: 'bg-purple-50 text-purple-700' },
};

/** "10 mins ago" / "Yesterday, 6:45 PM" / "12 May 2026". */
function relativeTime(iso: string): string {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const time = then.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const days = Math.round(hours / 24);
  if (days === 1) return `Yesterday, ${time}`;
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function NotificationsPage() {
  const [data, setData] = useState<NotificationList | null>(null);
  const [category, setCategory] = useState<NotificationCategory | null>(null);
  const [page, setPage] = useState(1);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [picks, setPicks] = useState<ProductListItem[]>([]);

  const load = useCallback(() => {
    const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (category) query.set('category', category);
    api<NotificationList>(`/api/notifications?${query.toString()}`, { auth: true })
      .then(setData)
      .catch(() => setError('Could not load your notifications'));
  }, [page, category]);

  useEffect(load, [load]);
  useEffect(() => {
    setUser(getStoredUser());
    api<{ items: ProductListItem[] }>('/api/products?limit=4&sort=popularity')
      .then((r) => setPicks(r.items))
      .catch(() => {});
  }, []);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(''), 3000);
  }

  function refreshBadges() {
    window.dispatchEvent(new Event(BADGES_EVENT));
  }

  async function markAll() {
    setBusy(true);
    try {
      await api('/api/notifications/read-all', { auth: true });
      load();
      refreshBadges();
      flash('All notifications marked as read');
    } catch {
      setError('Could not mark them read');
    } finally {
      setBusy(false);
    }
  }

  async function toggleRead(row: NotificationRow) {
    setMenuId(null);
    try {
      await api(`/api/notifications/${row.id}/read`, {
        body: { read: row.readAt === null },
        auth: true,
      });
      load();
      refreshBadges();
    } catch {
      setError('Could not update that notification');
    }
  }

  async function remove(id: string) {
    setMenuId(null);
    try {
      await api(`/api/notifications/${id}`, { method: 'DELETE', auth: true });
      load();
      refreshBadges();
    } catch {
      setError('Could not delete that notification');
    }
  }

  async function clearRead() {
    if (!confirm('Delete every notification you have already read?')) return;
    setBusy(true);
    try {
      const result = await api<{ deleted: number }>('/api/notifications', {
        method: 'DELETE',
        auth: true,
      });
      setPage(1);
      load();
      flash(`${result.deleted} read notification${result.deleted === 1 ? '' : 's'} cleared`);
    } catch {
      setError('Could not clear them');
    } finally {
      setBusy(false);
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
      flash('Alerts turned on for email, SMS and WhatsApp.');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update your preferences');
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
  const firstRow = data.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(page * PAGE_SIZE, data.total);
  const alertsOn = user?.prefs ? user.prefs.email || user.prefs.sms || user.prefs.whatsapp : false;

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
        <span className="font-medium text-ink-900">Notifications</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-page-title flex items-center gap-2 text-ink-900">
            Notifications
            {data.summary.unread > 0 && (
              <span className="t-badge flex h-6 min-w-6 items-center justify-center rounded-full bg-brand-600 px-2 text-white">
                {data.summary.unread}
              </span>
            )}
          </h1>
          <p className="t-section-desc mt-1 text-gray-500">
            Stay updated with your orders, offers and account activity.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void markAll()}
            disabled={busy || data.summary.unread === 0}
            className="t-btn rounded-lg border border-gray-300 px-4 py-2.5 text-ink-900 transition hover:border-brand-600 disabled:opacity-50"
          >
            ✉ Mark all as read
          </button>
          <Link
            href="/account/notifications/settings"
            className="t-btn rounded-lg border border-gray-300 px-4 py-2.5 text-ink-900 transition hover:border-brand-600"
          >
            ⚙ Notification Settings
          </Link>
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

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {/* Chips */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setCategory(null);
                setPage(1);
              }}
              className={`t-btn rounded-full px-4 py-2 transition ${
                category === null
                  ? 'bg-ink-900 text-white'
                  : 'border border-gray-300 text-gray-600 hover:border-ink-900'
              }`}
            >
              All ({data.summary.total})
            </button>
            {NOTIFICATION_CATEGORIES.filter((c) => data.summary.byCategory[c] > 0).map((c) => (
              <button
                key={c}
                onClick={() => {
                  setCategory(c);
                  setPage(1);
                }}
                className={`t-btn rounded-full px-4 py-2 transition ${
                  category === c
                    ? 'bg-ink-900 text-white'
                    : 'border border-gray-300 text-gray-600 hover:border-ink-900'
                }`}
              >
                {NOTIFICATION_CATEGORY_LABELS[c]} ({data.summary.byCategory[c]})
              </button>
            ))}
          </div>

          {/* Feed */}
          <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
            {data.items.length === 0 ? (
              <div className="py-16 text-center">
                <span className="text-4xl">🔔</span>
                <p className="t-body mt-3 text-gray-500">
                  {category
                    ? `No ${NOTIFICATION_CATEGORY_LABELS[category].toLowerCase()} notifications.`
                    : 'Nothing here yet — we’ll let you know when something happens.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {data.items.map((row) => {
                  const look = TYPE_ICON[row.type] ?? CATEGORY_ICON[row.category];
                  const unread = row.readAt === null;
                  return (
                    <li
                      key={row.id}
                      className={`relative flex items-start gap-3 px-4 py-4 ${
                        unread ? 'bg-brand-50/30' : ''
                      }`}
                    >
                      <span
                        className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                          unread ? 'bg-brand-600' : 'bg-gray-300'
                        }`}
                        aria-label={unread ? 'Unread' : 'Read'}
                      />
                      <span
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${look.tint}`}
                      >
                        {look.icon}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="t-card-label text-ink-900">{row.title}</p>
                        <p className="t-caption mt-0.5 text-gray-600">{row.body}</p>
                        {row.linkHref && (
                          <Link
                            href={row.linkHref}
                            onClick={() => {
                              if (unread) void toggleRead(row);
                            }}
                            className="t-caption mt-2 inline-block rounded-lg border border-brand-600 px-3 py-1.5 font-bold text-brand-700 transition hover:bg-brand-50"
                          >
                            {NOTIFICATION_CTA_LABELS[row.category]}
                          </Link>
                        )}
                      </div>

                      {row.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={row.imageUrl}
                          alt=""
                          loading="lazy"
                          className="hidden h-14 w-14 shrink-0 rounded-lg bg-cream-100 object-cover sm:block"
                        />
                      )}

                      <span className="t-caption hidden shrink-0 text-gray-400 sm:block">
                        {relativeTime(row.createdAt)}
                      </span>

                      <div className="relative shrink-0">
                        <button
                          onClick={() => setMenuId(menuId === row.id ? null : row.id)}
                          aria-label="Notification actions"
                          className="rounded-full px-2 py-1 text-lg leading-none text-gray-400 hover:bg-cream-100"
                        >
                          ⋮
                        </button>
                        {menuId === row.id && (
                          <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-gray-100 bg-white py-1 shadow-xl">
                            <button
                              onClick={() => void toggleRead(row)}
                              className="t-caption block w-full px-4 py-2 text-left text-gray-700 hover:bg-cream-100"
                            >
                              {unread ? 'Mark as read' : 'Mark as unread'}
                            </button>
                            <button
                              onClick={() => void remove(row.id)}
                              className="t-caption block w-full px-4 py-2 text-left text-red-600 hover:bg-red-50"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {data.total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-4 py-3.5">
                <p className="t-caption text-gray-500">
                  Showing {firstRow} to {lastRow} of {data.total} notifications
                </p>
                <div className="flex items-center gap-1.5">
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
                        n === page
                          ? 'border-ink-900 bg-ink-900 text-white'
                          : 'border-gray-300 text-ink-900'
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
              </div>
            )}
          </section>
        </div>

        {/* ── Right rail ─────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Notification Summary</h2>
            <dl className="mt-3 space-y-2.5">
              {[
                { label: 'Total Notifications', value: data.summary.total, accent: false },
                { label: 'Unread', value: data.summary.unread, accent: true },
                { label: 'Today', value: data.summary.today, accent: false },
                { label: 'This Week', value: data.summary.thisWeek, accent: false },
              ].map((row) => (
                <div key={row.label} className="flex justify-between">
                  <dt className="t-caption text-gray-600">{row.label}</dt>
                  <dd className={`t-card-label ${row.accent ? 'text-brand-600' : 'text-ink-900'}`}>
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-5 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-100 text-2xl">
              🔔
            </span>
            <p className="t-sub-heading mt-3 text-ink-900">Never miss an update!</p>
            <p className="t-caption mt-1 text-gray-600">
              {alertsOn
                ? 'Alerts are on for email, SMS and WhatsApp.'
                : 'Turn on alerts to hear about orders, offers and more.'}
            </p>
            {alertsOn ? (
              <Link
                href="/account/notifications/settings"
                className="t-btn mt-4 block rounded-lg border border-brand-600 py-2.5 text-brand-700 transition hover:bg-brand-50"
              >
                Manage alerts
              </Link>
            ) : (
              <button
                onClick={() => void enableAlerts()}
                className="t-btn mt-4 w-full rounded-lg bg-brand-600 py-2.5 text-white transition hover:bg-brand-700"
              >
                Enable Notifications
              </button>
            )}
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Quick Actions</h2>
            <ul className="mt-3 divide-y divide-gray-100">
              <li>
                <button
                  onClick={() => void markAll()}
                  disabled={data.summary.unread === 0}
                  className="flex w-full items-center gap-2.5 py-3 text-left transition hover:text-brand-600 disabled:opacity-40"
                >
                  <span className="w-5 text-center">✉</span>
                  <span className="min-w-0 flex-1">
                    <span className="t-card-label block text-ink-900">Mark all as read</span>
                    <span className="t-caption block text-gray-500">
                      Clear all unread notifications
                    </span>
                  </span>
                  <span className="shrink-0 text-gray-300">›</span>
                </button>
              </li>
              <li>
                <button
                  onClick={() => void clearRead()}
                  disabled={busy}
                  className="flex w-full items-center gap-2.5 py-3 text-left transition hover:text-red-600 disabled:opacity-40"
                >
                  <span className="w-5 text-center">🗑</span>
                  <span className="min-w-0 flex-1">
                    <span className="t-card-label block text-ink-900">Clear read notifications</span>
                    <span className="t-caption block text-gray-500">
                      Delete everything you have read
                    </span>
                  </span>
                  <span className="shrink-0 text-gray-300">›</span>
                </button>
              </li>
              <li>
                <Link
                  href="/account/notifications/settings"
                  className="flex items-center gap-2.5 py-3 transition hover:text-brand-600"
                >
                  <span className="w-5 text-center">⚙</span>
                  <span className="min-w-0 flex-1">
                    <span className="t-card-label block text-ink-900">Notification Settings</span>
                    <span className="t-caption block text-gray-500">Manage your preferences</span>
                  </span>
                  <span className="shrink-0 text-gray-300">›</span>
                </Link>
              </li>
              <li>
                <Link
                  href="/account/help"
                  className="flex items-center gap-2.5 py-3 transition hover:text-brand-600"
                >
                  <span className="w-5 text-center">❓</span>
                  <span className="min-w-0 flex-1">
                    <span className="t-card-label block text-ink-900">Help Center</span>
                    <span className="t-caption block text-gray-500">Get help with notifications</span>
                  </span>
                  <span className="shrink-0 text-gray-300">›</span>
                </Link>
              </li>
            </ul>
          </div>

          {picks.length > 0 && (
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="t-sub-heading text-ink-900">You May Also Like</h2>
              <ul className="mt-3 space-y-3">
                {picks.slice(0, 2).map((product) => {
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
                View Recommendations
              </Link>
            </div>
          )}
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
