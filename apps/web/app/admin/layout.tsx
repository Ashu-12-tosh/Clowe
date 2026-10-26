'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getStoredUser } from '@/lib/api';
import DashShell, { type DashNavItem } from '@/components/DashShell';
import CourierWalletBanner from '@/components/admin/CourierWalletBanner';

const NAV: DashNavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: '▦' },
  { href: '/admin/sellers', label: 'Sellers', icon: '🏪' },
  { href: '/admin/products', label: 'Products', icon: '👕' },
  { href: '/admin/categories', label: 'Categories', icon: '▤' },
  { href: '/admin/facets', label: 'Filter facets', icon: '⧩' },
  { href: '/admin/brands', label: 'Brands', icon: '◈' },
  { href: '/admin/banners', label: 'Banners', icon: '🖼' },
  { href: '/admin/category-banners', label: 'Category banners', icon: '🎞' },
  { href: '/admin/promos', label: 'Promos', icon: '🏷' },
  { href: '/admin/deals', label: 'Deals', icon: '⚡' },
  { href: '/admin/newsletter', label: 'Newsletter', icon: '✉' },
  { href: '/admin/tryon', label: 'AI Try-On Monitor', icon: '✦' },
  { href: '/admin/search', label: 'Search', icon: '⌕' },
  { href: '/admin/users', label: 'Users', icon: '👥' },
  { href: '/admin/orders', label: 'Orders', icon: '📦' },
  { href: '/admin/shipments', label: 'Parcels', icon: '🚚' },
  { href: '/admin/payments', label: 'Payments', icon: '💳' },
  { href: '/admin/cod-remittance', label: 'COD remittance', icon: '₹' },
  { href: '/admin/delhivery-billing', label: 'Delhivery billing', icon: '🧾' },
  { href: '/admin/returns', label: 'Returns', icon: '↩' },
  { href: '/admin/cod-refunds', label: 'COD refunds to pay', icon: '🏦' },
  { href: '/admin/payouts', label: 'Payout approvals', icon: '💸' },
  { href: '/admin/support', label: 'Support inbox', icon: '📮' },
  { href: '/admin/inventory', label: 'Inventory & Warehouse', icon: '🏭' },
  { href: '/admin/ads', label: 'Ads & sponsorship', icon: '📣' },
  { href: '/admin/ai', label: 'AI usage', icon: '✨' },
  { href: '/admin/emails', label: 'Emails', icon: '✉️' },
  { href: '/admin/seller-referrals', label: 'Referrals', icon: '🤝' },
  { href: '/admin/audit', label: 'Audit Logs', icon: '📋' },
  { href: '/admin/csp-reports', label: 'CSP Reports', icon: '🛡' },
  { href: '/admin/commercial', label: 'Commercial rules', icon: '₹' },
  { href: '/admin/referral-fees', label: 'Referral fee schedule', icon: '%' },
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
    <DashShell brand="Admin" subtitle="Platform Control" nav={NAV}>
      <CourierWalletBanner />
      <div className="mx-auto max-w-6xl">{children}</div>
    </DashShell>
  );
}
