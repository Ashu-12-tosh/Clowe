'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { SellerProfileInfo } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { SellerContext, type SellerState } from '@/components/seller/SellerContext';

const NAV = [
  { href: '/seller', label: 'Dashboard' },
  { href: '/seller/products', label: 'My Products' },
  { href: '/seller/products/new', label: 'Add Product' },
  { href: '/seller/orders', label: 'Orders' },
];

export default function SellerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<SellerState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

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
        {children}
      </SellerContext.Provider>
    );
  }

  if (state.kind === 'loading') {
    return <main className="mx-auto max-w-6xl px-4 py-10 text-sm text-gray-500">Loading…</main>;
  }

  if (state.kind === 'logged-out') {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Seller area</p>
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
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex flex-col gap-6 md:flex-row">
          <aside className="w-full shrink-0 md:w-52">
            <div className="rounded-2xl border border-gray-100 bg-white p-3">
              <div className="rounded-xl bg-ink-900 px-3.5 py-3 text-white">
                <p className="truncate text-sm font-bold">{state.profile.shopName}</p>
                <p className="mt-0.5 text-[11px] uppercase tracking-widest text-brand-400">
                  Seller Panel
                </p>
              </div>
              <nav className="mt-3 flex gap-2 overflow-x-auto md:flex-col md:gap-1">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm transition ${
                      pathname === item.href
                        ? 'bg-ink-900 font-semibold text-white shadow'
                        : 'text-gray-600 hover:bg-cream-100 hover:text-ink-900'
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          </aside>
          <section className="min-w-0 flex-1">{children}</section>
        </div>
      </main>
    </SellerContext.Provider>
  );
}
