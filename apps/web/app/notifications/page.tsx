'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { NotificationList } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';

const TYPE_ICONS: Record<string, string> = {
  ORDER_CONFIRMED: '🎉',
  NEW_ORDER: '🛍',
  ITEM_SHIPPED: '🚚',
  ITEM_DELIVERED: '📦',
  REFERRAL_CREDITED: '🎁',
  SELLER_APPROVED: '✅',
  SELLER_REJECTED: '❌',
  SELLER_SUSPENDED: '⛔',
  PRODUCT_APPROVED: '✅',
  PRODUCT_REJECTED: '❌',
};

export default function NotificationsPage() {
  const [data, setData] = useState<NotificationList | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);

  useEffect(() => {
    if (!getStoredUser()) {
      setLoggedOut(true);
      return;
    }
    api<NotificationList>('/api/notifications', { auth: true })
      .then((d) => {
        setData(d);
        // Opening the page marks everything read.
        if (d.unreadCount > 0) {
          void api('/api/notifications/read-all', { method: 'POST', body: {}, auth: true });
        }
      })
      .catch(() => setData({ items: [], unreadCount: 0 }));
  }, []);

  if (loggedOut) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Notifications</p>
        <p className="mt-2 text-sm text-gray-600">
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Login
          </Link>{' '}
          to see your notifications.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold">Notifications</h1>

      {data === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}
      {data && data.items.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">Nothing here yet — order updates, seller news, and referral rewards will show up here.</p>
      )}

      <div className="mt-4 space-y-2">
        {data?.items.map((n) => (
          <div
            key={n.id}
            className={`flex gap-3 rounded-xl border p-3.5 ${
              n.readAt ? 'border-gray-200 bg-white' : 'border-brand-100 bg-brand-100/30'
            }`}
          >
            <span className="text-xl">{TYPE_ICONS[n.type] ?? '🔔'}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{n.title}</p>
              <p className="mt-0.5 text-sm text-gray-600">{n.body}</p>
              <p className="mt-1 text-xs text-gray-400">
                {new Date(n.createdAt).toLocaleString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
            {!n.readAt && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand-600" />}
          </div>
        ))}
      </div>
    </main>
  );
}
