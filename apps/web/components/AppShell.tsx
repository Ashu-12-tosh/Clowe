'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { AuthUser, CategoryNode } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import Header from './Header';
import Footer from './Footer';

const ACCOUNT_LINKS = [
  { label: 'My Orders', href: '/orders', icon: '📦' },
  { label: 'Wishlist', href: '/wishlist', icon: '♡' },
  { label: 'Cart', href: '/cart', icon: '🛍' },
  { label: 'My Account', href: '/account', icon: '👤' },
  { label: 'Clowe Credits', href: '/credits', icon: '🪙' },
  { label: 'Refer & Earn', href: '/referrals', icon: '🎁' },
  { label: 'AI Try-On', href: '/tryon', icon: '✨' },
  { label: 'Track Order', href: '/track', icon: '🚚' },
];

/** Mobile drawer: category tree (expandable) + account shortcuts. */
function MobileDrawer({ onNavigate }: { onNavigate: () => void }) {
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    api<CategoryNode[]>('/api/categories').then(setTree).catch(() => {});
    setUser(getStoredUser());
  }, []);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="bg-ink-950 px-5 py-4 text-white">
        <span className="block text-[10px] leading-none text-brand-400">♛</span>
        <span className="font-display text-xl font-bold uppercase tracking-[0.2em]">Clowe</span>
        <p className="mt-1 text-xs text-gray-400">
          {user ? `Hi, ${user.name?.split(' ')[0] ?? 'there'}` : 'Welcome! Login to shop faster.'}
        </p>
      </div>

      <p className="px-5 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wide text-gray-400">
        Shop by category
      </p>
      <nav>
        {tree.map((cat) => (
          <div key={cat.id} className="border-b border-gray-50">
            <div className="flex items-center">
              <Link
                href={`/products?category=${cat.slug}`}
                onClick={onNavigate}
                className="flex flex-1 items-center gap-3 px-5 py-2.5 text-sm text-gray-800"
              >
                <span className="text-base">{cat.icon ?? '▸'}</span>
                {cat.name}
              </Link>
              {cat.children.length > 0 && (
                <button
                  onClick={() => setOpenId((v) => (v === cat.id ? null : cat.id))}
                  aria-label={`Expand ${cat.name}`}
                  className="px-4 py-2.5 text-xs text-gray-400"
                >
                  {openId === cat.id ? '▴' : '▾'}
                </button>
              )}
            </div>
            {openId === cat.id && (
              <div className="bg-cream-50 pb-1.5">
                {cat.children.map((child) => (
                  <Link
                    key={child.id}
                    href={`/products?category=${child.slug}`}
                    onClick={onNavigate}
                    className="block py-1.5 pl-14 pr-4 text-sm text-gray-600"
                  >
                    {child.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>

      <p className="px-5 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wide text-gray-400">
        Your account
      </p>
      <nav className="pb-6">
        {ACCOUNT_LINKS.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            onClick={onNavigate}
            className="flex items-center gap-3 px-5 py-2.5 text-sm text-gray-800"
          >
            <span className="w-5 text-center">{item.icon}</span>
            {item.label}
          </Link>
        ))}
        {user?.role === 'SELLER' && (
          <Link href="/seller" onClick={onNavigate} className="flex items-center gap-3 px-5 py-2.5 text-sm text-gray-800">
            <span className="w-5 text-center">🏪</span>Seller Panel
          </Link>
        )}
        {user?.role === 'ADMIN' && (
          <Link href="/admin" onClick={onNavigate} className="flex items-center gap-3 px-5 py-2.5 text-sm text-gray-800">
            <span className="w-5 text-center">🛡</span>Admin Panel
          </Link>
        )}
        {!user && (
          <Link
            href="/login"
            onClick={onNavigate}
            className="mx-5 mt-2 block rounded-lg bg-brand-600 px-4 py-2.5 text-center text-sm font-bold text-white"
          >
            Login / Sign up
          </Link>
        )}
      </nav>
    </div>
  );
}

/**
 * App-wide chrome: top utility bar + header + category nav, content, footer.
 * Mobile gets a slide-in drawer with the category tree. Pure layout.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawerOpen(false), [pathname]);

  // Standalone areas render their own chrome: the login page, and the
  // admin/seller dashboards (which have dedicated shells — no shopping nav).
  if (pathname === '/login' || pathname.startsWith('/admin') || pathname.startsWith('/seller')) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header onMenuClick={() => setDrawerOpen(true)} />

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setDrawerOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="absolute inset-y-0 left-0 w-80 max-w-[85vw] bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <MobileDrawer onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex-1">{children}</div>
      <Footer />
    </div>
  );
}
