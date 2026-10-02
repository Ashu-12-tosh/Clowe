'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getPublicSettings } from '@/lib/settings';
import { ExternalLink } from '@/components/ExternalLink';
import { safeHref } from '@clowe/shared';

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

/**
 * Social marks, drawn to the same recipe as the other icons in this app —
 * 20px box, no fill, 1.8 stroke in currentColor — since there is no icon
 * library and every icon here is written by hand.
 */
const ICON = {
  'aria-hidden': true,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: 'h-5 w-5',
} as const;

function FacebookIcon() {
  return (
    <svg {...ICON}>
      <path d="M12.75 3.25h-1.5a3 3 0 0 0-3 3V9H6.5v2.75h1.75v5h2.75v-5h2l.5-2.75h-2.5V6.5a.5.5 0 0 1 .5-.5h1.75Z" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg {...ICON}>
      <rect x="3" y="3" width="14" height="14" rx="4" />
      <circle cx="10" cy="10" r="3.25" />
      <circle cx="14.25" cy="5.75" r="0.5" fill="currentColor" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg {...ICON}>
      <rect x="3" y="3" width="14" height="14" rx="2.5" />
      <path d="M6.75 9v4.5" />
      <circle cx="6.75" cy="6.5" r="0.5" fill="currentColor" />
      <path d="M9.75 13.5V9m0 1.5a2 2 0 0 1 4 0v3" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg {...ICON}>
      <path d="m4.5 4.5 11 11m0-11-11 11" />
    </svg>
  );
}

type SocialLinks = { facebook: string; twitter: string; instagram: string; linkedin: string };

export default function Footer() {
  const [social, setSocial] = useState<SocialLinks>({
    facebook: '',
    twitter: '',
    instagram: '',
    linkedin: '',
  });

  useEffect(() => {
    getPublicSettings()
      .then((s) => setSocial(s.socialLinks))
      .catch(() => {});
  }, []);

  // Only networks with a link. A greyed-out "coming soon" mark is a promise
  // the footer has no business making.
  const socialLinks = [
    { Icon: FacebookIcon, label: 'Clowe on Facebook', href: social.facebook },
    { Icon: InstagramIcon, label: 'Clowe on Instagram', href: social.instagram },
    { Icon: LinkedInIcon, label: 'Clowe on LinkedIn', href: social.linkedin },
    { Icon: XIcon, label: 'Clowe on X', href: social.twitter },
  ].filter((s) => safeHref(s.href));

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
          {socialLinks.length > 0 && (
            <div className="mt-4 flex items-center gap-1 text-gray-400">
              {socialLinks.map(({ Icon, label, href }) => (
                <ExternalLink
                  key={label}
                  href={href}
                  aria-label={label}
                  // 44px tap target around a 20px mark; the row stays one line tall.
                  className="flex h-11 w-11 items-center justify-center rounded-full transition hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600"
                >
                  <Icon />
                </ExternalLink>
              ))}
            </div>
          )}
        </div>

        {/* Link columns */}
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h3 className="t-footer-head text-ink-900">{col.title}</h3>
            <ul className="mt-3 space-y-2">
              {col.links.map((link) => (
                <li key={link.label}>
                  {/* eslint-disable-next-line no-restricted-syntax -- route from a table defined in code, not data */}
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
