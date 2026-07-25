'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getStoredUser } from '@/lib/api';

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/sellers', label: 'Sellers' },
  { href: '/admin/products', label: 'Products' },
  { href: '/admin/categories', label: 'Categories' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/orders', label: 'Orders' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // null = checking, false = not admin, true = admin (server still enforces).
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    setIsAdmin(getStoredUser()?.role === 'ADMIN');
  }, []);

  if (isAdmin === null) {
    return <main className="mx-auto max-w-6xl px-4 py-10 text-sm text-gray-500">Loading…</main>;
  }

  if (!isAdmin) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Admin area</p>
        <p className="mt-2 text-sm text-gray-600">
          This area is only for the platform admin.{' '}
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Login
          </Link>{' '}
          with the admin account.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex flex-col gap-6 md:flex-row">
        <aside className="w-full shrink-0 md:w-52">
          <div className="rounded-2xl border border-gray-100 bg-white p-3">
            <div className="rounded-xl bg-ink-900 px-3.5 py-3 text-white">
              <p className="font-display text-sm font-bold uppercase tracking-[0.15em] text-brand-400">
                Clowe Admin
              </p>
              <p className="mt-0.5 text-[11px] uppercase tracking-widest text-gray-400">
                Platform control
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
  );
}
