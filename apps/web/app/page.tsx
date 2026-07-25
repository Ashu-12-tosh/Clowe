import Link from 'next/link';
import ApiStatus from '@/components/ApiStatus';
import TopPicks from '@/components/TopPicks';

const CATEGORIES = [
  { name: 'Men', slug: 'men', emoji: '👔' },
  { name: 'Women', slug: 'women', emoji: '👗' },
  { name: 'Kids', slug: 'kids', emoji: '🧸' },
  { name: 'T-Shirts', slug: 'men-t-shirts', emoji: '👕' },
  { name: 'Dresses', slug: 'women-dresses', emoji: '💃' },
  { name: 'Jeans', slug: 'men-jeans', emoji: '👖' },
  { name: 'Kurtis', slug: 'women-kurtis', emoji: '🥻' },
  { name: 'Jackets', slug: 'men-jackets', emoji: '🧥' },
];

const FEATURES = [
  { icon: '🚚', title: 'Free Shipping', text: 'On orders ₹999+' },
  { icon: '↩️', title: 'Easy Returns', text: 'Simple return flow' },
  { icon: '🔒', title: 'Secure Payment', text: '100% protected' },
  { icon: '🤖', title: 'AI Assistant', text: 'Here to help you' },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-4">
      {/* ---------------- Hero ---------------- */}
      <section className="mt-4 overflow-hidden rounded-3xl bg-ink-900 text-white">
        <div className="grid items-center gap-8 p-8 sm:p-12 lg:grid-cols-2">
          <div>
            <h1 className="font-display text-4xl font-bold leading-tight sm:text-5xl">
              AI Try-On
              <br />
              See Yourself In
              <br />
              <span className="text-brand-400">Any Outfit</span>
            </h1>
            <p className="mt-4 max-w-md text-sm text-gray-300">
              Upload your photo once and try on thousands of styles instantly — before you buy.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/products"
                className="rounded-lg bg-brand-600 px-6 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-brand-700"
              >
                Try AI Try-On
              </Link>
              <Link
                href="/products"
                className="rounded-lg border border-brand-400 px-6 py-3 text-sm font-bold uppercase tracking-wide text-brand-400 hover:bg-white/5"
              >
                Explore Styles
              </Link>
            </div>
          </div>
          {/* Before / after visual */}
          <div className="hidden justify-end lg:flex">
            <div className="relative">
              <div className="flex h-64 w-52 flex-col items-center justify-center rounded-2xl bg-ink-700 text-gray-500">
                <span className="text-5xl">🧍</span>
                <span className="mt-2 text-[10px] uppercase tracking-widest">Before</span>
              </div>
              <div className="absolute -bottom-6 -right-14 flex h-64 w-52 flex-col items-center justify-center rounded-2xl border-2 border-brand-400 bg-cream-100 text-ink-900 shadow-2xl">
                <span className="text-5xl">🕺</span>
                <span className="mt-2 text-[10px] font-bold uppercase tracking-widest text-brand-600">
                  After ✨
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- Feature strip ---------------- */}
      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {FEATURES.map((feature) => (
          <div
            key={feature.title}
            className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-3.5"
          >
            <span className="text-2xl">{feature.icon}</span>
            <div>
              <p className="text-sm font-bold text-ink-900">{feature.title}</p>
              <p className="text-xs text-gray-500">{feature.text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* ---------------- Shop by Categories ---------------- */}
      <section className="py-10">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Shop by Categories</h2>
          <Link href="/products" className="text-sm font-semibold text-brand-600 hover:underline">
            View all →
          </Link>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-3 sm:grid-cols-8">
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.slug}
              href={`/products?category=${cat.slug}`}
              className="group flex flex-col items-center gap-2"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cream-100 text-3xl transition group-hover:bg-brand-100 sm:h-20 sm:w-20">
                {cat.emoji}
              </span>
              <span className="text-xs font-medium text-gray-700 group-hover:text-brand-600">
                {cat.name}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* ---------------- Top Picks ---------------- */}
      <TopPicks />

      {/* Dev status (small) */}
      <section className="pb-10">
        <ApiStatus />
      </section>
    </main>
  );
}
