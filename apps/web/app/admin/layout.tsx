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
        <aside className="w-full shrink-0 md:w-48">
          <p className="text-sm font-bold">Clowe Admin</p>
          <p className="mt-0.5 text-xs text-gray-500">Platform control</p>
          <nav className="mt-4 flex gap-2 overflow-x-auto md:flex-col md:gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                  pathname === item.href
                    ? 'bg-brand-100 font-semibold text-brand-600'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <section className="min-w-0 flex-1">{children}</section>
      </div>
    </main>
  );
}
