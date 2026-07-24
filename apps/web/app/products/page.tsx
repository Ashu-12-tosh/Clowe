'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { CategoryNode, ProductListResponse, ProductSort } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import ProductCard from '@/components/ProductCard';
import PriceRangeSlider from '@/components/PriceRangeSlider';

/** Collapsible filter group — click the title to expand/collapse. */
function FilterSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-4 border-b border-gray-100 pb-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-sm font-semibold text-gray-800 hover:text-brand-600"
      >
        {title}
        <span className={`text-xs text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>
      {open && <div className="mt-2.5">{children}</div>}
    </div>
  );
}

function ProductsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [data, setData] = useState<ProductListResponse | null>(null);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const q = searchParams.get('q') ?? '';
  const category = searchParams.get('category') ?? '';
  const sizes = (searchParams.get('sizes') ?? '').split(',').filter(Boolean);
  const colors = (searchParams.get('colors') ?? '').split(',').filter(Boolean);
  const minPrice = searchParams.get('minPrice') ?? '';
  const maxPrice = searchParams.get('maxPrice') ?? '';
  const sort = (searchParams.get('sort') ?? 'newest') as ProductSort;
  const page = Number(searchParams.get('page') ?? '1');

  /** Update one or more query params (resets to page 1 unless page is set). */
  const setParams = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      if (!('page' in updates)) next.delete('page');
      for (const [key, value] of Object.entries(updates)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      router.push(`/products?${next.toString()}`);
    },
    [router, searchParams],
  );

  useEffect(() => {
    api<CategoryNode[]>('/api/categories').then(setCategories).catch(() => {});
    fetchWishlistIds().then(setWishlistIds);
  }, []);

  useEffect(() => {
    setLoading(true);
    setError('');
    api<ProductListResponse>(`/api/products?${searchParams.toString()}`)
      .then(setData)
      .catch(() => setError('Could not load products. Is the API running?'))
      .finally(() => setLoading(false));
  }, [searchParams]);

  const toggleListParam = (key: 'sizes' | 'colors', value: string, current: string[]) => {
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    setParams({ [key]: next.join(',') });
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex flex-col gap-6 md:flex-row">
        {/* ---------------- Filters sidebar ---------------- */}
        <aside className="w-full shrink-0 md:w-56">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Filters</h2>

          <div className="mt-4">
            <h3 className="text-sm font-semibold">Category</h3>
            <ul className="mt-2 space-y-1 text-sm">
              <li>
                <button
                  onClick={() => setParams({ category: '' })}
                  className={!category ? 'font-semibold text-brand-600' : 'text-gray-600 hover:text-brand-600'}
                >
                  All
                </button>
              </li>
              {categories.map((root) => (
                <li key={root.id}>
                  <button
                    onClick={() => setParams({ category: root.slug })}
                    className={category === root.slug ? 'font-semibold text-brand-600' : 'text-gray-600 hover:text-brand-600'}
                  >
                    {root.name}
                  </button>
                  <ul className="ml-3 mt-1 space-y-1">
                    {root.children.map((child) => (
                      <li key={child.id}>
                        <button
                          onClick={() => setParams({ category: child.slug })}
                          className={category === child.slug ? 'font-semibold text-brand-600' : 'text-gray-500 hover:text-brand-600'}
                        >
                          {child.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>

          {data && data.facets.sizes.length > 0 && (
            <FilterSection title="Size" defaultOpen={sizes.length > 0}>
              <div className="flex flex-wrap gap-1.5">
                {data.facets.sizes.map((size) => (
                  <button
                    key={size}
                    onClick={() => toggleListParam('sizes', size, sizes)}
                    className={`rounded border px-2 py-1 text-xs ${
                      sizes.includes(size)
                        ? 'border-brand-600 bg-brand-100 font-semibold text-brand-600'
                        : 'border-gray-300 text-gray-600 hover:border-brand-600'
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </FilterSection>
          )}

          {data && data.facets.colors.length > 0 && (
            <FilterSection title="Colour" defaultOpen={colors.length > 0}>
              <div className="flex flex-wrap gap-1.5">
                {data.facets.colors.map((color) => (
                  <button
                    key={color}
                    onClick={() => toggleListParam('colors', color, colors)}
                    className={`rounded border px-2 py-1 text-xs ${
                      colors.includes(color)
                        ? 'border-brand-600 bg-brand-100 font-semibold text-brand-600'
                        : 'border-gray-300 text-gray-600 hover:border-brand-600'
                    }`}
                  >
                    {color}
                  </button>
                ))}
              </div>
            </FilterSection>
          )}

          {data?.facets.priceRange && (
            <div className="mt-5">
              <h3 className="text-base font-bold">Price</h3>
              <div className="mt-2">
                <PriceRangeSlider
                  min={Math.floor(data.facets.priceRange.minPaise / 100)}
                  max={Math.ceil(data.facets.priceRange.maxPaise / 100)}
                  valueMin={minPrice ? Number(minPrice) : null}
                  valueMax={maxPrice ? Number(maxPrice) : null}
                  onApply={(lo, hi) =>
                    setParams({ minPrice: lo ? String(lo) : '', maxPrice: hi ? String(hi) : '' })
                  }
                />
              </div>
            </div>
          )}

          {(q || category || sizes.length > 0 || colors.length > 0 || minPrice || maxPrice) && (
            <Link href="/products" className="mt-5 inline-block text-xs text-brand-600 hover:underline">
              Clear all filters
            </Link>
          )}
        </aside>

        {/* ---------------- Results ---------------- */}
        <section className="flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-gray-600">
              {q && (
                <>
                  Results for <span className="font-semibold">&ldquo;{q}&rdquo;</span> ·{' '}
                </>
              )}
              {data ? `${data.total} products` : '…'}
            </p>
            <select
              value={sort}
              onChange={(e) => setParams({ sort: e.target.value })}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm outline-none"
            >
              <option value="newest">Newest</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
            </select>
          </div>

          {error && (
            <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {loading && !data && (
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-[3/4] animate-pulse rounded-xl bg-gray-200" />
              ))}
            </div>
          )}

          {data && data.items.length === 0 && (
            <p className="mt-10 text-center text-sm text-gray-500">
              No products match these filters.
            </p>
          )}

          {data && data.items.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {data.items.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  inWishlist={wishlistIds.has(product.id)}
                />
              ))}
            </div>
          )}

          {data && totalPages > 1 && (
            <div className="mt-8 flex items-center justify-center gap-3 text-sm">
              <button
                disabled={page <= 1}
                onClick={() => setParams({ page: String(page - 1) })}
                className="rounded border border-gray-300 px-3 py-1.5 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span className="text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setParams({ page: String(page + 1) })}
                className="rounded border border-gray-300 px-3 py-1.5 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default function ProductsPage() {
  return (
    <Suspense>
      <ProductsPageInner />
    </Suspense>
  );
}
