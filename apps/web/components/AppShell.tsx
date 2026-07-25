'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { AuthUser } from '@clowe/shared';
import { getStoredUser } from '@/lib/api';
import Header from './Header';
import Footer from './Footer';

interface NavItem {
  label: string;
  href: string;
  icon: string;
  /** Highlight when the pathname matches exactly (default) or by prefix. */
  match?: 'exact' | 'prefix';
}

const SHOP_NAV: NavItem[] = [
  { label: 'Home', href: '/', icon: '⌂' },
  { label: 'Categories', href: '/products', icon: '▦' },
  { label: 'Men', href: '/products?category=men', icon: '👔' },
  { label: 'Women', href: '/products?category=women', icon: '👗' },
  { label: 'Kids', href: '/products?category=kids', icon: '🧸' },
  { label: 'Footwear', href: '/products', icon: '👟' },
  { label: 'Accessories', href: '/products', icon: '👜' },
  { label: 'Brands', href: '/products', icon: '◈' },
  { label: 'AI Try-On', href: '/tryon', icon: '✨', match: 'prefix' },
  { label: 'AI Studio', href: '/tryon', icon: '🎨' },
  { label: 'Offers', href: '/products', icon: '🏷' },
];

const ACCOUNT_NAV: NavItem[] = [
  { label: 'Wishlist', href: '/wishlist', icon: '♡', match: 'prefix' },
  { label: 'Cart', href: '/cart', icon: '🛍', match: 'prefix' },
  { label: 'Orders', href: '/orders', icon: '📦', match: 'prefix' },
  { label: 'Profile', href: '/login', icon: '👤', match: 'prefix' },
  { label: 'Clowe Credits', href: '/referrals', icon: '🪙', match: 'prefix' },
  { label: 'Settings', href: '/login', icon: '⚙' },
];

function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const base = item.href.split('?')[0];
  const active =
    item.match === 'prefix' ? pathname.startsWith(base) && base !== '/' : pathname === item.href;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm transition ${
        active
          ? 'bg-ink-900 font-semibold text-white shadow'
          : 'text-gray-600 hover:bg-cream-100 hover:text-ink-900'
      }`}
    >
      <span className="w-5 text-center text-base leading-none">{item.icon}</span>
      {item.label}
    </Link>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => setUser(getStoredUser()), [pathname]);

  return (
    <div className="flex h-full flex-col px-3 py-5">
      {/* Logo */}
      <Link href="/" onClick={onNavigate} className="px-3">
        <span className="font-display text-2xl font-bold uppercase tracking-[0.25em] text-brand-600">
          Clowe
        </span>
      </Link>

      <nav className="mt-6 space-y-1">
        {SHOP_NAV.map((item) => (
          <NavLink key={item.label} item={item} pathname={pathname} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="my-4 border-t border-gray-100" />

      <nav className="space-y-1">
        {ACCOUNT_NAV.map((item) => (
          <NavLink key={item.label} item={item} pathname={pathname} onNavigate={onNavigate} />
        ))}
        {user?.role === 'SELLER' && (
          <NavLink
            item={{ label: 'Seller Panel', href: '/seller', icon: '🏪', match: 'prefix' }}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        )}
        {user?.role === 'ADMIN' && (
          <NavLink
            item={{ label: 'Admin Panel', href: '/admin', icon: '🛡', match: 'prefix' }}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        )}
      </nav>

      {/* Promo card */}
      <div className="mt-6 rounded-2xl bg-ink-900 p-4 text-white">
        <p className="text-sm font-bold uppercase tracking-wide">
          Get <span className="text-brand-400">20% Off</span>
        </p>
        <p className="mt-0.5 text-xs text-gray-400">On your first order</p>
        <Link
          href="/products"
          onClick={onNavigate}
          className="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-brand-700"
        >
          SHOP NOW
        </Link>
      </div>

      <div className="mt-auto flex items-center gap-4 px-3 pt-6 text-sm text-gray-400">
        <span className="cursor-pointer hover:text-ink-900">ⓕ</span>
        <span className="cursor-pointer hover:text-ink-900">𝕏</span>
        <span className="cursor-pointer hover:text-ink-900">◎</span>
        <span className="cursor-pointer hover:text-ink-900">▶</span>
      </div>
    </div>
  );
}

/**
 * App-wide chrome: fixed left sidebar on desktop, slide-in drawer on mobile,
 * slim top bar, content column, footer. Pure layout — no business logic.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawerOpen(false), [pathname]);

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 overflow-y-auto border-r border-gray-100 bg-white lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setDrawerOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenuClick={() => setDrawerOpen(true)} />
        <div className="flex-1">{children}</div>
        <Footer />
      </div>
    </div>
  );
}
