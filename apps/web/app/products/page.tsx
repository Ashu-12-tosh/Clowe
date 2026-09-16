'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { CategoryNode, ProductListResponse, ProductSort, SearchDroppable } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import ProductCard from '@/components/ProductCard';
import SearchSummary from '@/components/search/SearchSummary';

/** Every chip 'Clear all' removes. Kept local: it is a UI affordance, not a contract. */
const ALL_DROPPABLE: SearchDroppable[] = ['minPrice','maxPrice','brands','onSale','category','sort'];
import { trackAdClick, useSponsoredAds } from '@/components/SponsoredAds';
import PriceRangeSlider from '@/components/PriceRangeSlider';
import { colorToHex } from '@/lib/colors';

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
  // Mobile filter bottom-sheet (visual only — same filter logic underneath).
  const [sheetOpen, setSheetOpen] = useState(false);

  const q = searchParams.get('q') ?? '';
  const category = searchParams.get('category') ?? '';
  // Option filters live in the URL as opt[<axis>]=a,b — one entry per axis.
  const optionFilters: Record<string, string[]> = {};
  searchParams.forEach((value, key) => {
    if (!key.startsWith('opt[') || !key.endsWith(']')) return;
    optionFilters[key.slice(4, -1)] = value.split(',').filter(Boolean);
  });
  const activeOptionCount = Object.values(optionFilters).reduce((n, v) => n + v.length, 0);
  const minPrice = searchParams.get('minPrice') ?? '';
  const maxPrice = searchParams.get('maxPrice') ?? '';
  const sort = (searchParams.get('sort') ?? 'newest') as ProductSort;
  const dropped = (searchParams.get('drop') ?? '')
    .split(',')
    .filter(Boolean) as SearchDroppable[];
  const page = Number(searchParams.get('page') ?? '1');

  // Sponsored products render inline at the top of category listings —
  // identical cards, just a small "Sponsored" label. Organic duplicates skipped.
  const sponsoredAds = useSponsoredAds(
    category && page === 1 ? 'CATEGORY_SPONSORED' : null,
    category || undefined,
  );
  const adProductIds = new Set(sponsoredAds.map((ad) => ad.product.id));
  const organicItems = (data?.items ?? []).filter((p) => !adProductIds.has(p.id));

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

  // Lock page scroll while the mobile sheet is open.
  useEffect(() => {
    document.body.style.overflow = sheetOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [sheetOpen]);

  const toggleOption = (axis: string, value: string) => {
    const current = optionFilters[axis] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    setParams({ [`opt[${axis}]`]: next.join(',') });
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const activeFilterCount =
    (category ? 1 : 0) + activeOptionCount + (minPrice || maxPrice ? 1 : 0);
  const hasAnyFilter = Boolean(q) || activeFilterCount > 0;

  /** All filter options — rendered in the desktop sidebar AND the mobile sheet. */
  const renderFilters = (inSheet: boolean) => (
    <>
      <div className={inSheet ? '' : 'mt-4'}>
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

      {/* One filter group per option axis in scope - colour as swatches, the rest as chips */}
      {data?.facets.options.map((facet) => {
        const active = optionFilters[facet.key] ?? [];
        return (
          <FilterSection
            key={facet.key}
            title={facet.label}
            defaultOpen={inSheet || active.length > 0}
          >
            {facet.key === 'color' ? (
              <div className="flex flex-wrap gap-2">
                {facet.values.map((color) => {
                  const hex = colorToHex(color);
                  const on = active.includes(color);
                  return (
                    <button
                      key={color}
                      onClick={() => toggleOption(facet.key, color)}
                      title={color}
                      className={`flex h-7 w-7 items-center justify-center rounded-full border-2 transition ${
                        on ? 'border-brand-600 ring-2 ring-brand-100' : 'border-gray-200 hover:border-gray-400'
                      }`}
                      style={hex ? { backgroundColor: hex } : undefined}
                    >
                      {!hex && (
                        <span className="text-[9px] font-bold text-gray-500">{color.slice(0, 2)}</span>
                      )}
                      {on && hex && (
                        <span className={hex === '#ffffff' || hex === '#f5e6c8' ? 'text-ink-900' : 'text-white'}>
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {facet.values.map((value) => (
                  <button
                    key={value}
                    onClick={() => toggleOption(facet.key, value)}
                    className={`rounded border px-2 py-1 text-xs ${
                      active.includes(value)
                        ? 'border-brand-600 bg-brand-100 font-semibold text-brand-600'
                        : 'border-gray-300 text-gray-600 hover:border-brand-600'
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </div>
            )}
          </FilterSection>
        );
      })}

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

      {!inSheet && hasAnyFilter && (
        <Link href="/products" className="mt-5 inline-block text-xs text-brand-600 hover:underline">
          Clear all filters
        </Link>
      )}
    </>
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex flex-col gap-6 md:flex-row">
        {/* ---------------- Desktop filters sidebar (unchanged) ---------------- */}
        <aside className="hidden w-full shrink-0 md:block md:w-56">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Filters</h2>
          {renderFilters(false)}
        </aside>

        {/* ---------------- Results ---------------- */}
        <section className="min-w-0 flex-1">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-ink-900">
                {q
                  ? `Results for “${q}”`
                  : (categories
                      .flatMap((root) => [root, ...root.children])
                      .find((c) => c.slug === category)?.name ?? 'All Products')}
              </h1>
              <p className="mt-0.5 text-sm text-gray-500">{data ? `${data.total} Products` : '…'}</p>
            </div>
            {/* Desktop sort (mobile uses the chip bar below) */}
            <select
              value={sort}
              onChange={(e) => setParams({ sort: e.target.value })}
              className="hidden rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm outline-none md:block"
            >
              <option value="newest">Newest</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
            </select>
          </div>

          {/* ---------------- Mobile filter chip bar ---------------- */}
          <div className="sticky top-[var(--header-h,108px)] z-10 -mx-4 mt-3 flex items-center gap-2 overflow-x-auto border-b border-gray-100 bg-cream-50/95 px-4 py-2 backdrop-blur md:hidden">
            <button
              onClick={() => setSheetOpen(true)}
              className={`relative flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-semibold ${
                activeFilterCount > 0
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-gray-300 bg-white text-ink-900'
              }`}
            >
              ⚙ Filters
              {activeFilterCount > 0 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-[11px] font-bold text-white">
                  {activeFilterCount}
                </span>
              )}
            </button>
            <select
              value={sort}
              onChange={(e) => setParams({ sort: e.target.value })}
              className="shrink-0 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-ink-900 outline-none"
            >
              <option value="newest">Sort: Newest</option>
              <option value="price_asc">Price: low → high</option>
              <option value="price_desc">Price: high → low</option>
            </select>
            {hasAnyFilter && (
              <Link
                href="/products"
                className="shrink-0 rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-sm text-gray-600"
              >
                Clear ✕
              </Link>
            )}
          </div>

          {error && (
            <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {loading && !data && (
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-square animate-pulse rounded-xl bg-gray-200" />
              ))}
            </div>
          )}

          {data?.search && (
            <SearchSummary
              meta={data.search}
              dropped={dropped}
              categoryName={
                data.search.parsed.filters.inferredCategorySlug
                  ? (categories.find(
                      (c) => c.slug === data.search!.parsed.filters.inferredCategorySlug,
                    )?.name ?? null)
                  : null
              }
              onDrop={(key) =>
                setParams({ drop: [...new Set([...dropped, key])].join(',') })
              }
              onClearAll={() =>
                setParams({ drop: [...new Set([...dropped, ...ALL_DROPPABLE])].join(',') })
              }
            />
          )}

          {data && data.items.length === 0 && (
            <div className="mt-10 text-center">
              <p className="text-sm font-semibold text-ink-900">
                {q ? `Nothing matches "${q}".` : 'No products match these filters.'}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {q
                  ? 'Try fewer words, check the spelling, or drop a filter.'
                  : 'Try removing a filter to widen the search.'}
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {/* A dead end is the one thing a zero-result page must not be. */}
                {dropped.length < ALL_DROPPABLE.length && data.search && (
                  <button
                    onClick={() =>
                      setParams({ drop: [...new Set([...dropped, ...ALL_DROPPABLE])].join(',') })
                    }
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-ink-900 hover:border-brand-600"
                  >
                    Search without the filters
                  </button>
                )}
                <button
                  onClick={() => router.push('/products')}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-ink-900 hover:border-brand-600"
                >
                  Browse everything
                </button>
              </div>
              {categories.length > 0 && (
                <div className="mt-6">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                    Or jump to a department
                  </p>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    {categories.slice(0, 6).map((c) => (
                      <button
                        key={c.slug}
                        onClick={() => router.push(`/products?category=${c.slug}`)}
                        className="rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-brand-600 hover:text-brand-700"
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {data && (data.items.length > 0 || sponsoredAds.length > 0) && (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {sponsoredAds.map((ad) => (
                <ProductCard
                  key={`ad-${ad.id}`}
                  product={ad.product}
                  inWishlist={wishlistIds.has(ad.product.id)}
                  sponsored
                  onNavigate={() => trackAdClick(ad.id)}
                />
              ))}
              {organicItems.map((product) => (
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

      {/* ---------------- Mobile filter bottom sheet ---------------- */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setSheetOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-3xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Sheet header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="text-base font-bold">
                Filters
                {activeFilterCount > 0 && (
                  <span className="ml-2 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-700">
                    {activeFilterCount} applied
                  </span>
                )}
              </h2>
              <button
                onClick={() => setSheetOpen(false)}
                aria-label="Close filters"
                className="rounded-full p-1.5 text-xl text-gray-400 hover:bg-gray-100"
              >
                ×
              </button>
            </div>

            {/* Scrollable filter options (results update live behind the sheet) */}
            <div className="flex-1 overflow-y-auto px-5 pb-4 pt-2">{renderFilters(true)}</div>

            {/* Sticky action bar */}
            <div className="flex gap-3 border-t border-gray-100 px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
              <button
                onClick={() => {
                  setSheetOpen(false);
                  router.push('/products');
                }}
                className="flex-1 rounded-xl border border-gray-300 py-3 text-sm font-bold uppercase tracking-wide text-ink-900"
              >
                Clear All
              </button>
              <button
                onClick={() => setSheetOpen(false)}
                className="flex-1 rounded-xl bg-ink-900 py-3 text-sm font-bold uppercase tracking-wide text-white"
              >
                Apply{data ? ` (${data.total})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}
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
