import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl px-4 py-24 text-center">
      <p className="text-6xl">🧵</p>
      <h1 className="mt-4 text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-sm text-gray-600">
        This page seems to have gone out of stock. Let&apos;s get you back to shopping.
      </p>
      <Link
        href="/products"
        className="mt-6 inline-block rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Browse products →
      </Link>
    </main>
  );
}
