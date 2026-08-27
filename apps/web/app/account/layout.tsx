'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { AuthUser, MyCounts } from '@clowe/shared';
import { api, getStoredUser, logoutSession, setStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/**
 * Sidebar items. External hrefs point at pages that already exist elsewhere
 * (orders, wishlist, wallet, help) so there is only ever one of each.
 */
type Badge = 'wishlist' | 'notifications' | 'wallet';

const NAV: { href: string; label: string; icon: string; badge?: Badge }[] = [
  { href: '/account', label: 'Dashboard', icon: '🏠' },
  { href: '/account/orders', label: 'My Orders', icon: '📦' },
  { href: '/wishlist', label: 'Wishlist', icon: '♡', badge: 'wishlist' },
  { href: '/account/addresses', label: 'My Addresses', icon: '📍' },
  { href: '/account/payments', label: 'Payment Methods', icon: '💳' },
  { href: '/account/credits', label: 'Clowe Credits', icon: '👛', badge: 'wallet' },
  { href: '/account/returns', label: 'Returns & Refunds', icon: '↩' },
  { href: '/account/coupons', label: 'My Coupons', icon: '🎟' },
  { href: '/account/recently-viewed', label: 'Recently Viewed', icon: '🕘' },
  { href: '/account/notifications', label: 'Notifications', icon: '🔔', badge: 'notifications' },
  { href: '/account/settings', label: 'Account Settings', icon: '⚙' },
  { href: '/account/help', label: 'Help Center', icon: '❓' },
];

const PREMIUM_PERKS = [
  'Free & fast delivery',
  'Priority customer support',
  'Early access to sales',
  'Member-only coupons',
];

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [counts, setCounts] = useState<MyCounts>({ cart: 0, wishlist: 0, notifications: 0 });
  const [walletPaise, setWalletPaise] = useState<number | null>(null);

  useEffect(() => {
    const stored = getStoredUser();
    if (!stored) {
      router.replace('/login');
      return;
    }
    setUser(stored);
    // Refresh the cached profile (prefs, avatar, premium…) in the background.
    api<AuthUser>('/api/auth/me', { auth: true })
      .then((fresh) => {
        setStoredUser(fresh);
        setUser(fresh);
      })
      .catch(() => {});
    api<MyCounts>('/api/me/counts', { auth: true }).then(setCounts).catch(() => {});
    api<{ valuePaise: number }>('/api/credits', { auth: true })
      .then((c) => setWalletPaise(c.valuePaise))
      .catch(() => {});
  }, [router]);

  /** Badge text for a nav row, or null when there's nothing to show. */
  function badgeFor(badge: Badge | undefined): string | null {
    if (badge === 'wishlist') return counts.wishlist > 0 ? String(counts.wishlist) : null;
    if (badge === 'notifications') return counts.notifications > 0 ? String(counts.notifications) : null;
    if (badge === 'wallet') return walletPaise ? formatPaise(walletPaise) : null;
    return null;
  }

  async function logout() {
    await logoutSession();
    window.location.href = '/login';
  }

  if (!user) {
    return (
      <main className="mx-auto max-w-7xl animate-pulse px-4 py-6">
        <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="h-96 rounded-2xl bg-cream-100" />
          <div className="h-96 rounded-2xl bg-cream-100" />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-10 pt-4">
      <div className="grid items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="space-y-4 lg:sticky lg:top-4">
          {/* Profile card */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4 text-center">
            <span className="mx-auto flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-cream-100 text-2xl">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                '👤'
              )}
            </span>
            <p className="t-sub-heading mt-2.5 text-ink-900">
              {user.name ?? 'Your account'}
            </p>
            {user.isPremium && (
              <p className="mt-0.5 text-xs font-bold text-brand-600">♛ Premium Member</p>
            )}
            {user.email && <p className="mt-1.5 truncate text-xs text-gray-500">{user.email}</p>}
            <p className="text-xs text-gray-500">+91 {user.phone}</p>
          </div>

          {/* Nav */}
          <nav className="overflow-hidden rounded-2xl border border-gray-100 bg-white py-1.5">
            {NAV.map((item) => {
              const active =
                item.href === '/account'
                  ? pathname === '/account'
                  : pathname.startsWith(item.href);
              const badge = badgeFor(item.badge);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`t-sidebar flex items-center gap-2.5 border-l-[3px] px-4 py-2.5 transition ${
                    active
                      ? 'border-brand-600 bg-brand-50/60 font-bold text-brand-700'
                      : 'border-transparent text-gray-600 hover:bg-cream-50 hover:text-ink-900'
                  }`}
                >
                  <span className="w-5 text-center">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {badge && (
                    <span
                      className={`t-badge shrink-0 rounded-full px-2 py-0.5 ${
                        item.badge === 'wallet'
                          ? 'bg-brand-50 text-brand-700'
                          : 'bg-brand-600 text-white'
                      }`}
                    >
                      {badge}
                    </span>
                  )}
                </Link>
              );
            })}
            {(user.role === 'SELLER' || user.role === 'ADMIN') && (
              <Link
                href={user.role === 'SELLER' ? '/seller' : '/admin'}
                className="flex items-center gap-2.5 border-l-[3px] border-transparent px-4 py-2.5 text-sm text-gray-600 transition hover:bg-cream-50 hover:text-ink-900"
              >
                <span className="w-5 text-center">{user.role === 'SELLER' ? '🏪' : '🛡'}</span>
                {user.role === 'SELLER' ? 'Seller Panel' : 'Admin Panel'}
              </Link>
            )}
            <button
              onClick={() => void logout()}
              className="mt-1 flex w-full items-center gap-2.5 border-l-[3px] border-transparent border-t border-t-gray-100 px-4 py-2.5 text-left text-sm font-semibold text-red-600 transition hover:bg-red-50"
            >
              <span className="w-5 text-center">⎋</span>
              Logout
            </button>
          </nav>
          {!user.isPremium && (
            <div className="overflow-hidden rounded-2xl bg-ink-950 p-4 text-white">
              <p className="t-sub-heading text-brand-400">♛ CLOWE Premium</p>
              <p className="t-caption mt-1 text-gray-300">Unlock exclusive benefits</p>
              <ul className="mt-3 space-y-1.5">
                {PREMIUM_PERKS.map((perk) => (
                  <li key={perk} className="t-caption flex items-start gap-2 text-gray-300">
                    <span className="text-brand-400">✦</span>
                    {perk}
                  </li>
                ))}
              </ul>
              <Link
                href="/pages/help"
                className="t-btn mt-4 block rounded-lg bg-brand-600 py-2 text-center text-white transition hover:bg-brand-700"
              >
                Explore Premium ›
              </Link>
            </div>
          )}
        </aside>

        <div className="min-w-0">{children}</div>
      </div>
    </main>
  );
}
