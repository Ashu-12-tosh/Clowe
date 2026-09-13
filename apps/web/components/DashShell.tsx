'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { AuthUser } from '@clowe/shared';
import { api, getStoredUser, logoutSession } from '@/lib/api';

export interface DashNavItem {
  href: string;
  label: string;
  icon: string;
  /** Optional count badge (e.g. pending returns). Hidden when 0/undefined. */
  badge?: number;
}

/** Longest matching nav href wins (so /seller/products/new → "Add Product"). */
function activeItem(nav: DashNavItem[], pathname: string): DashNavItem | null {
  let best: DashNavItem | null = null;
  for (const item of nav) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best;
}

function SidebarContent({
  brand,
  subtitle,
  nav,
  pathname,
  onNavigate,
}: {
  brand: string;
  subtitle: string;
  nav: DashNavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = activeItem(nav, pathname);
  return (
    <div className="flex h-full flex-col px-3 py-5">
      {/* Brand card */}
      <div className="rounded-2xl bg-ink-900 px-4 py-3.5 text-white">
        <p className="t-logo-sm truncate uppercase text-brand-400">
          {brand}
        </p>
        <p className="mt-0.5 truncate text-[11px] uppercase tracking-widest text-gray-400">
          {subtitle}
        </p>
      </div>

      <nav className="mt-5 space-y-1">
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm transition ${
              active?.href === item.href
                ? 'bg-ink-900 font-semibold text-white shadow'
                : 'text-gray-600 hover:bg-cream-100 hover:text-ink-900'
            }`}
          >
            <span className="w-5 text-center text-base leading-none">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {!!item.badge && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] font-bold text-white">
                {item.badge > 9 ? '9+' : item.badge}
              </span>
            )}
          </Link>
        ))}
      </nav>

      <div className="mt-auto border-t border-gray-100 px-3.5 pt-4">
        <Link
          href="/"
          onClick={onNavigate}
          className="text-xs font-semibold text-gray-500 hover:text-brand-600"
        >
          ← Visit main website
        </Link>
      </div>
    </div>
  );
}

/**
 * Dedicated dashboard chrome for the admin and seller areas: own sidebar +
 * top bar, hamburger drawer on mobile — no customer shopping nav anywhere.
 * Pure layout; role guards stay in the route layouts.
 */
export default function DashShell({
  brand,
  subtitle,
  nav,
  children,
}: {
  brand: string;
  subtitle: string;
  nav: DashNavItem[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    setUser(getStoredUser());
    api<{ unreadCount: number }>('/api/notifications', { auth: true })
      .then((d) => setUnread(d.unreadCount))
      .catch(() => {});
  }, [pathname]);
  // Close overlays on navigation.
  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  async function logout() {
    await logoutSession();
    window.location.href = '/login';
  }

  const title = activeItem(nav, pathname)?.label ?? brand;

  return (
    <div className="flex min-h-screen bg-cream-50">
      {/* Desktop sidebar */}
      <aside
        data-print-hide
        className="sticky top-0 hidden h-screen w-60 shrink-0 overflow-y-auto border-r border-gray-100 bg-white lg:block"
      >
        <SidebarContent brand={brand} subtitle={subtitle} nav={nav} pathname={pathname} />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setDrawerOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <SidebarContent
              brand={brand}
              subtitle={subtitle}
              nav={nav}
              pathname={pathname}
              onNavigate={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header
          data-print-hide
          className="sticky top-0 z-40 border-b border-gray-100 bg-white/90 backdrop-blur"
        >
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            <button
              onClick={() => setDrawerOpen(true)}
              className="rounded-lg p-2 text-xl leading-none hover:bg-cream-100 lg:hidden"
              aria-label="Open menu"
            >
              ☰
            </button>
            <h1 className="t-page-title min-w-0 flex-1 truncate text-ink-900">
              {title}
            </h1>

            <Link
              href="/notifications"
              className="relative rounded-full p-2 text-lg hover:bg-cream-100"
              aria-label="Notifications"
            >
              🔔
              {unread > 0 && (
                <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </Link>

            {/* Account menu */}
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-900 text-sm font-bold text-white"
                aria-label="Account menu"
              >
                {(user?.name?.[0] ?? 'A').toUpperCase()}
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
                    <div className="border-b border-gray-100 px-4 py-3">
                      <p className="truncate text-sm font-semibold text-ink-900">
                        {user?.name ?? 'Account'}
                      </p>
                      {user?.phone && <p className="text-xs text-gray-500">+91 {user.phone}</p>}
                    </div>
                    <Link
                      href="/"
                      className="block px-4 py-2.5 text-sm text-gray-700 hover:bg-cream-100"
                      onClick={() => setMenuOpen(false)}
                    >
                      🛍 Visit main website
                    </Link>
                    <button
                      onClick={() => void logout()}
                      className="block w-full px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50"
                    >
                      ⎋ Logout
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
