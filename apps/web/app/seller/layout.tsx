'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { SellerProfileInfo } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { SellerContext, type SellerState } from '@/components/seller/SellerContext';
import DashShell, { type DashNavItem } from '@/components/DashShell';

const NAV: DashNavItem[] = [
  { href: '/seller', label: 'Dashboard', icon: '▦' },
  { href: '/seller/products', label: 'My Products', icon: '👕' },
  { href: '/seller/products/new', label: 'Add Product', icon: '＋' },
  { href: '/seller/inventory', label: 'Inventory', icon: '▤' },
  { href: '/seller/orders', label: 'Orders', icon: '📦' },
  { href: '/seller/returns', label: 'Returns', icon: '↩' },
  { href: '/seller/payouts', label: 'Payouts', icon: '₹' },
  { href: '/seller/customers', label: 'Customers', icon: '👥' },
  { href: '/seller/promotions', label: 'Promotions', icon: '🏷' },
  { href: '/seller/ads', label: 'Advertise', icon: '📣' },
  { href: '/seller/settings', label: 'Store Settings', icon: '⚙' },
  { href: '/seller/support', label: 'Support', icon: '💬' },
];

/** Minimal chrome for the public seller pages (login / register). */
function SellerPublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-cream-50">
      <header className="bg-ink-950 px-5 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <Link href="/sell" className="font-display text-lg font-bold uppercase tracking-[0.2em] text-brand-400">
            Clowe <span className="text-white">Seller</span>
          </Link>
          <Link href="/" className="text-sm font-semibold text-gray-300 hover:text-brand-400">
            Go to store →
          </Link>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}

export default function SellerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<SellerState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingReturns, setPendingReturns] = useState(0);

  // Sidebar badge: returns waiting for a decision (refreshed on navigation).
  useEffect(() => {
    if (state.kind !== 'ready') return;
    api<{ count: number }>('/api/seller/returns/pending-count', { auth: true })
      .then((d) => setPendingReturns(d.count))
      .catch(() => {});
  }, [state.kind, pathname]);

  useEffect(() => {
    if (!getStoredUser()) {
      setState({ kind: 'logged-out' });
      return;
    }
    api<SellerProfileInfo>('/api/seller/profile', { auth: true })
      .then((profile) => setState({ kind: 'ready', profile }))
      .catch((err) => {
        if (err instanceof ApiRequestError && err.code === 'SELLER_PROFILE_REQUIRED') {
          setState({ kind: 'not-registered' });
        } else {
          setState({ kind: 'logged-out' });
        }
      });
  }, [reloadKey]);

  // Not registered yet → send to the registration page (which renders freely).
  useEffect(() => {
    if (state.kind === 'not-registered' && pathname !== '/seller/register') {
      router.replace('/seller/register');
    }
  }, [state, pathname, router]);

  // Public seller pages — register and seller-login render without the guard.
  if (pathname === '/seller/register' || pathname === '/seller/login') {
    return (
      <SellerContext.Provider value={{ state, reload: () => setReloadKey((k) => k + 1) }}>
        <SellerPublicShell>{children}</SellerPublicShell>
      </SellerContext.Provider>
    );
  }

  if (state.kind === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-cream-50 text-sm text-gray-500">
        Loading…
      </main>
    );
  }

  if (state.kind === 'logged-out') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-cream-50 px-4 text-center">
        <p className="font-display text-xl font-bold text-ink-900">Seller area</p>
        <p className="mt-2 text-sm text-gray-600">
          <Link href="/seller/login" className="font-semibold text-brand-600 hover:underline">
            Seller login
          </Link>{' '}
          to open your dashboard, or{' '}
          <Link href="/sell" className="font-semibold text-brand-600 hover:underline">
            register your shop
          </Link>
          .
        </p>
      </main>
    );
  }

  if (state.kind === 'not-registered') {
    return null; // redirecting to /seller/register
  }

  return (
    <SellerContext.Provider value={{ state, reload: () => setReloadKey((k) => k + 1) }}>
      <DashShell
        brand={state.profile.shopName}
        subtitle="Seller Panel"
        nav={NAV.map((item) =>
          item.href === '/seller/returns' ? { ...item, badge: pendingReturns } : item,
        )}
      >
        <div className="mx-auto max-w-6xl">{children}</div>
      </DashShell>
    </SellerContext.Provider>
  );
}
