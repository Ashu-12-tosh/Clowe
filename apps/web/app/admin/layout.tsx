'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getStoredUser } from '@/lib/api';
import DashShell, { type DashNavItem } from '@/components/DashShell';

const NAV: DashNavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: '▦' },
  { href: '/admin/sellers', label: 'Sellers', icon: '🏪' },
  { href: '/admin/products', label: 'Products', icon: '👕' },
  { href: '/admin/categories', label: 'Categories', icon: '▤' },
  { href: '/admin/brands', label: 'Brands', icon: '◈' },
  { href: '/admin/banners', label: 'Banners', icon: '🖼' },
  { href: '/admin/promos', label: 'Promos', icon: '🏷' },
  { href: '/admin/deals', label: 'Deals', icon: '⚡' },
  { href: '/admin/newsletter', label: 'Newsletter', icon: '✉' },
  { href: '/admin/tryon', label: 'AI Try-On Monitor', icon: '✦' },
  { href: '/admin/users', label: 'Users', icon: '👥' },
  { href: '/admin/orders', label: 'Orders', icon: '📦' },
  { href: '/admin/payments', label: 'Payments', icon: '💳' },
  { href: '/admin/returns', label: 'Returns', icon: '↩' },
  { href: '/admin/support', label: 'Customer Support', icon: '📮' },
  { href: '/admin/inventory', label: 'Inventory & Warehouse', icon: '🏭' },
  { href: '/admin/ads', label: 'Ads', icon: '📣' },
  { href: '/admin/seller-referrals', label: 'Referrals', icon: '🤝' },
  { href: '/admin/audit', label: 'Audit Logs', icon: '📋' },
  { href: '/admin/settings', label: 'Settings', icon: '⚙' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // null = checking, false = not admin, true = admin (server still enforces).
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    setIsAdmin(getStoredUser()?.role === 'ADMIN');
  }, []);

  if (isAdmin === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-cream-50 text-sm text-gray-500">
        Loading…
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-cream-50 px-4 text-center">
        <p className="font-display text-xl font-bold text-ink-900">Admin area</p>
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
    <DashShell brand="Clowe Admin" subtitle="Platform Control" nav={NAV}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </DashShell>
  );
}
