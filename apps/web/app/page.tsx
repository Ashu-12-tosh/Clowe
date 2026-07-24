import Link from 'next/link';
import ApiStatus from '@/components/ApiStatus';

const categories = [
  { name: 'Men', slug: 'men', emoji: '👔' },
  { name: 'Women', slug: 'women', emoji: '👗' },
  { name: 'Kids', slug: 'kids', emoji: '🧸' },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-4">
      {/* Hero */}
      <section className="py-16 text-center">
        <span className="inline-block rounded-full bg-brand-100 px-4 py-1 text-sm font-medium text-brand-600">
          Phase 2 — Product Catalog
        </span>
        <h1 className="mt-6 text-5xl font-bold tracking-tight text-brand-900">Clowe</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-gray-600">
          Multi-vendor clothing marketplace with AI virtual try-on. Fashion, tried on by you.
        </p>
        <Link
          href="/products"
          className="mt-8 inline-block rounded-lg bg-brand-600 px-8 py-3 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Shop now →
        </Link>
      </section>

      {/* Category tiles */}
      <section className="pb-12">
        <h2 className="text-xl font-bold">Shop by category</h2>
        <div className="mt-4 grid grid-cols-3 gap-4">
          {categories.map((cat) => (
            <Link
              key={cat.slug}
              href={`/products?category=${cat.slug}`}
              className="rounded-xl border border-gray-200 bg-white p-6 text-center transition hover:border-brand-600 hover:shadow-md"
            >
              <span className="text-4xl">{cat.emoji}</span>
              <p className="mt-3 font-semibold">{cat.name}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Dev status */}
      <section className="pb-12">
        <ApiStatus />
      </section>
    </main>
  );
}
