import Link from 'next/link';

/**
 * Thin black strip that used to sit above the main header: app download and
 * seller links, the shipping / returns announcement, and Help & Support.
 *
 * Currently NOT rendered anywhere. To bring it back, import it in Header.tsx
 * and render <UtilityBar /> as the first child of the <header>.
 */
export default function UtilityBar() {
  return (
    <div className="bg-ink-950 text-[11px] text-gray-300 sm:text-xs">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-1.5">
        <div className="hidden items-center gap-4 sm:flex">
          <Link href="/pages/app" className="hover:text-white">📱 Download App</Link>
          <Link href="/sell" className="hover:text-white">🏪 Become a Seller</Link>
        </div>
        <p className="t-announce mx-auto truncate text-center sm:absolute sm:left-1/2 sm:-translate-x-1/2">
          <span className="font-semibold text-brand-400">Free Shipping</span> on orders above ₹499
          <span className="mx-1.5 text-gray-500">|</span>7 Days Easy Returns
        </p>
        <Link href="/pages/help" className="hidden shrink-0 hover:text-white sm:block">
          🎧 Help &amp; Support
        </Link>
      </div>
    </div>
  );
}
