'use client';

import Link from 'next/link';

interface FooterLink {
  label: string;
  href: string;
}

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Get to Know Us',
    links: [
      { label: 'About Clowe', href: '/' },
      { label: 'Careers', href: '#' },
      { label: 'Press Releases', href: '#' },
      { label: 'Clowe Science', href: '#' },
    ],
  },
  {
    title: 'Connect with Us',
    links: [
      { label: 'Facebook', href: '#' },
      { label: 'Twitter', href: '#' },
      { label: 'Instagram', href: '#' },
    ],
  },
  {
    title: 'Make Money with Us',
    links: [
      { label: 'Sell on Clowe', href: '/sell' },
      { label: 'Sell under Clowe Accelerator', href: '/sell' },
      { label: 'Protect and Build Your Brand', href: '#' },
      { label: 'Supply to Clowe', href: '#' },
      { label: 'Advertise Your Products', href: '#' },
    ],
  },
  {
    title: 'Let Us Help You',
    links: [
      { label: 'Your Account', href: '/login' },
      { label: 'Returns Centre', href: '/orders' },
      { label: 'Recalls and Product Safety Alerts', href: '#' },
      { label: '100% Purchase Protection', href: '#' },
      { label: 'Clowe App Download', href: '#' },
      { label: 'Help', href: '/track' },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="mt-16">
      {/* Back to top */}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        className="block w-full bg-[#37475a] py-3.5 text-center text-sm text-white transition hover:bg-[#485769]"
      >
        Back to top
      </button>

      {/* Link columns */}
      <div className="bg-[#232f3e] text-white">
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-8 px-6 py-10 sm:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h3 className="text-base font-bold">{col.title}</h3>
              <ul className="mt-3 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-gray-300 hover:text-white hover:underline"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-gray-600/40 bg-[#232f3e] pb-8 pt-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-4 px-6">
          <Link href="/" className="text-2xl font-bold tracking-tight text-white">
            Clowe
          </Link>
          <span className="rounded border border-gray-500 px-3 py-1.5 text-sm text-gray-300">
            🌐 English
          </span>
          <span className="rounded border border-gray-500 px-3 py-1.5 text-sm text-gray-300">
            🇮🇳 India
          </span>
        </div>
        <p className="mt-4 text-center text-xs text-gray-400">
          © {new Date().getFullYear()} Clowe — Fashion, tried on by you
        </p>
      </div>
    </footer>
  );
}
