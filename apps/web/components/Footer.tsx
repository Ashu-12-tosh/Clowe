'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getPublicSettings } from '@/lib/settings';

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: 'Shop',
    links: [
      { label: 'All Categories', href: '/products' },
      { label: 'Electronics', href: '/products?category=electronics' },
      { label: 'Mobiles', href: '/products?category=mobiles' },
      { label: 'Fashion', href: '/products?category=fashion' },
      { label: 'Home & Kitchen', href: '/products?category=home-kitchen' },
      { label: 'Beauty', href: '/products?category=beauty' },
      { label: 'Books', href: '/products?category=books' },
    ],
  },
  {
    title: 'Customer Care',
    links: [
      { label: 'Help Center', href: '/pages/help' },
      { label: 'Track Order', href: '/track' },
      { label: 'Returns & Refunds', href: '/pages/returns-refunds' },
      { label: 'Shipping Info', href: '/pages/shipping-info' },
      { label: 'Cancellation', href: '/pages/cancellation' },
      { label: 'FAQ', href: '/pages/faq' },
    ],
  },
  {
    title: 'About Us',
    links: [
      { label: 'About CLOWE', href: '/pages/about' },
      { label: 'Careers', href: '/pages/careers' },
      { label: 'Blog', href: '/pages/blog' },
      { label: 'Press', href: '/pages/press' },
      { label: 'Become a Seller', href: '/sell' },
      { label: 'Affiliate Program', href: '/pages/affiliate' },
    ],
  },
  {
    title: 'Policies',
    links: [
      { label: 'Privacy Policy', href: '/pages/privacy-policy' },
      { label: 'Terms & Conditions', href: '/pages/terms-conditions' },
      { label: 'Shipping Policy', href: '/pages/shipping-policy' },
      { label: 'Return Policy', href: '/pages/return-policy' },
      { label: 'Payment Policy', href: '/pages/payment-policy' },
      { label: 'Cookie Policy', href: '/pages/cookie-policy' },
    ],
  },
];

const PAYMENT_METHODS = ['VISA', 'MasterCard', 'RuPay', 'UPI', 'Paytm'];

export default function Footer() {
  const [social, setSocial] = useState<{ facebook: string; twitter: string; instagram: string }>({
    facebook: '',
    twitter: '',
    instagram: '',
  });

  useEffect(() => {
    getPublicSettings()
      .then((s) => setSocial(s.socialLinks))
      .catch(() => {});
  }, []);

  const socialLinks = [
    { glyph: '◎', label: 'Instagram', href: social.instagram },
    { glyph: 'ⓕ', label: 'Facebook', href: social.facebook },
    { glyph: '▶', label: 'YouTube', href: '' },
    { glyph: '𝕏', label: 'Twitter', href: social.twitter },
  ];

  return (
    <footer className="mt-16 border-t border-gray-100 bg-white">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-12 sm:grid-cols-2 lg:grid-cols-6">
        {/* Brand blurb */}
        <div className="lg:col-span-2 lg:pr-8">
          <Link href="/" className="inline-block leading-none">
            <span className="block text-[10px] leading-none text-brand-400">♛</span>
            <span className="t-logo-sm block uppercase text-ink-900">
              Clowe
            </span>
          </Link>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-gray-500">
            CLOWE is your one-stop destination for everything you love. Shop smarter. Live better.
          </p>
          <div className="mt-4 flex items-center gap-3 text-lg text-gray-400">
            {socialLinks.map((s) =>
              s.href ? (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={s.label}
                  className="transition hover:text-ink-900"
                >
                  {s.glyph}
                </a>
              ) : (
                <span key={s.label} title={`${s.label} — coming soon`} className="cursor-default">
                  {s.glyph}
                </span>
              ),
            )}
          </div>
        </div>

        {/* Link columns */}
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h3 className="t-footer-head text-ink-900">{col.title}</h3>
            <ul className="mt-3 space-y-2">
              {col.links.map((link) => (
                <li key={link.label}>
                  <Link href={link.href} className="t-footer-link text-gray-500 hover:text-brand-600 hover:underline">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Payments + bottom bar */}
      <div className="border-t border-gray-100">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 py-5 sm:flex-row">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Secure Payments
            </span>
            {PAYMENT_METHODS.map((method) => (
              <span
                key={method}
                className="rounded border border-gray-200 bg-cream-50 px-2.5 py-1 text-[11px] font-bold text-gray-600"
              >
                {method}
              </span>
            ))}
            <span className="ml-1 text-xs text-gray-500">🛡 100% Secure Payments</span>
          </div>
          <p className="t-copyright text-gray-400">
            © {new Date().getFullYear()} CLOWE. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
