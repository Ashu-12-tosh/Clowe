'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_CTA_LABELS,
  type NotificationCategory,
  type NotificationList,
  type NotificationRow,
} from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import { BADGES_EVENT } from '@/components/Header';

const PAGE_SIZE = 10;

/** Rolling windows in the "received in" dropdown; the year list follows them. */
const ROLLING_PERIODS = [
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '3m', label: 'Past 3 months', months: 3 },
  { key: '6m', label: 'Past 6 months', months: 6 },
  { key: '9m', label: 'Past 9 months', months: 9 },
] as const;
const DEFAULT_PERIOD: string = '3m';

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

/** createdAt window for a period key: "30d" / "3m" / … or a year like "2025". */
function periodRange(period: string): { from?: string; to?: string } {
  const rolling = ROLLING_PERIODS.find((p) => p.key === period);
  if (rolling) {
    const from = new Date();
    if ('days' in rolling) from.setDate(from.getDate() - rolling.days);
    else from.setMonth(from.getMonth() - rolling.months);
    return { from: from.toISOString() };
  }
  const year = Number(period);
  if (!Number.isInteger(year)) return {};
  return {
    from: new Date(year, 0, 1).toISOString(),
    to: new Date(year + 1, 0, 1).toISOString(),
  };
}

/** How the period reads inside a sentence: "the past 3 months", "2025". */
function periodPhrase(period: string): string {
  const rolling = ROLLING_PERIODS.find((p) => p.key === period);
  return rolling ? `the ${rolling.label.toLowerCase()}` : period;
}

/**
 * Standalone notifications page: title, filters and the feed — nothing else.
 * Lives outside the account shell so the bell opens just the list.
 */
export default function NotificationsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<NotificationList | null>(null);
  const [category, setCategory] = useState<NotificationCategory | null>(null);
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // Login gate — the feed is meaningless without a session.
  useEffect(() => {
    if (!getStoredUser()) {
      router.replace('/login');
      return;
    }
    setReady(true);
  }, [router]);

  const load = useCallback(() => {
    if (!ready) return;
    const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (category) query.set('category', category);
    const { from, to } = periodRange(period);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    api<NotificationList>(`/api/notifications?${query.toString()}`, { auth: true })
      .then(setData)
      .catch(() => setError('Could not load your notifications'));
  }, [ready, page, category, period]);

  useEffect(load, [load]);

  // Years to offer: this year back to the year of the oldest notification.
  const firstAt = data?.summary.firstAt ?? null;
  const years = useMemo(() => {
    const thisYear = new Date().getFullYear();
    const first = firstAt ? new Date(firstAt).getFullYear() : thisYear;
    const list: number[] = [];
    for (let y = thisYear; y >= Math.min(first, thisYear); y -= 1) list.push(y);
    return list;
  }, [firstAt]);

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
      await api('/api/notifications/read-all', { method: 'POST', auth: true });
      load();
      refreshBadges();
      flash('All notifications marked as read');
    } catch {
      setError('Could not mark them read');
    } finally {
      setBusy(false);
    }
  }

  /** Clicking anywhere on a notification marks it read. */
  async function markRead(row: NotificationRow) {
    if (row.readAt !== null) return;
    try {
      await api(`/api/notifications/${row.id}/read`, {
        body: { read: true },
        auth: true,
      });
      load();
      refreshBadges();
    } catch {
      setError('Could not update that notification');
    }
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-4xl animate-pulse space-y-4 px-4 pb-10 pt-4">
        <div className="h-12 w-64 rounded-lg bg-cream-100" />
        <div className="h-96 rounded-2xl bg-cream-100" />
      </main>
    );
  }

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const firstRow = data.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(page * PAGE_SIZE, data.total);
  const hasAny = data.summary.total > 0;

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 pb-10 pt-4">
      <nav className="flex items-center text-xs">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1.5 font-semibold text-ink-900 transition hover:border-brand-600"
        >
          ← Back
        </button>
      </nav>

      <div className="text-center">
        <div>
          <h1 className="t-page-title flex items-center justify-center gap-2 text-ink-900">
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
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => void markAll()}
            disabled={busy || data.summary.unread === 0}
            className="t-btn rounded-lg border border-gray-300 px-4 py-2.5 text-ink-900 transition hover:border-brand-600 disabled:opacity-50"
          >
            ✉ Mark all as read
          </button>
          <Link
            href="/notifications/settings"
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

      {/* Category chips + "received in" period */}
      <div className="flex flex-wrap items-center justify-between gap-3">
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
            All
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
              {NOTIFICATION_CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <span>
            <span className="font-bold text-ink-900">{data.total}</span>{' '}
            {data.total === 1 ? 'notification' : 'notifications'} in
          </span>
          <select
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setPage(1);
            }}
            aria-label="Time period"
            className="t-body rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 outline-none focus:border-brand-600"
          >
            {ROLLING_PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Feed */}
      <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
        {data.items.length === 0 ? (
          <div className="py-16 text-center">
            <span className="text-4xl">🔔</span>
            <p className="t-body mt-3 text-gray-500">
              {!hasAny
                ? 'Nothing here yet — we’ll let you know when something happens.'
                : `No ${
                    category ? `${NOTIFICATION_CATEGORY_LABELS[category].toLowerCase()} ` : ''
                  }notifications in ${periodPhrase(period)}.`}
            </p>
            {hasAny && (
              <p className="t-caption mt-1 text-gray-400">Try a different time period above.</p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.items.map((row) => {
              const look = TYPE_ICON[row.type] ?? CATEGORY_ICON[row.category];
              const unread = row.readAt === null;
              return (
                <li
                  key={row.id}
                  onClick={() => void markRead(row)}
                  className={`relative flex items-start gap-3 px-4 py-4 ${
                    unread ? 'cursor-pointer bg-brand-50/30 transition hover:bg-brand-50/60' : ''
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
          </div>
        )}
      </section>
    </main>
  );
}
