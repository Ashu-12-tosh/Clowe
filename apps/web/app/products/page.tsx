'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  SEARCH_SORT_LABELS,
  railFilterCount,
  withChipRemoved,
  withRailCleared,
  withValueToggled,
  type AppliedFilter,
  type CategoryNode,
  type ProductListResponse,
  type ProductSort,
  type RailFacet,
  type SearchDroppable,
} from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import ProductCard from '@/components/ProductCard';
import SearchSummary from '@/components/search/SearchSummary';

/** Every chip 'Clear all' removes. Kept local: it is a UI affordance, not a contract. */
const ALL_DROPPABLE: SearchDroppable[] = ['minPrice','maxPrice','brands','onSale','category','sort'];
import { trackAdClick, useSponsoredAds } from '@/components/SponsoredAds';
import FilterRail from '@/components/search/FilterRail';
import AppliedFilters from '@/components/search/AppliedFilters';
import FilterSheet from '@/components/search/FilterSheet';

function ProductsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [data, setData] = useState<ProductListResponse | null>(null);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Phone and tablet: the rail opens as a bottom sheet over the results.
  const [sheetOpen, setSheetOpen] = useState(false);

  const q = searchParams.get('q') ?? '';
  const category = searchParams.get('category') ?? '';
  // Only what the shopper picked. With nothing picked, a search is in whatever
  // order the server applied — the words' sort ("best" -> top rated), or
  // relevance — so the dropdown reads that back instead of a default the
  // results are not in. Browsing without a search keeps its old default.
  const chosenSort = searchParams.get('sort') as ProductSort | null;
  const sortValue: string =
    chosenSort ?? (q ? (data?.search?.appliedSort ?? 'relevance') : 'newest');

  // Every order a search can be in has an option, so the dropdown always has
  // a true answer. Labels are the ones the chips use, so "Top rated" in a chip
  // and in the dropdown are visibly the same thing.
  const sortOptions: { value: string; label: string }[] = [
    ...(q ? [{ value: 'relevance', label: 'Relevance' }] : []),
    ...(q ? (['rating', 'popularity'] as const) : ([] as const)).map((value) => ({
      value,
      label: SEARCH_SORT_LABELS[value],
    })),
    ...(['newest', 'price_asc', 'price_desc'] as const).map((value) => ({
      value,
      label: SEARCH_SORT_LABELS[value],
    })),
  ];
  // "Relevance" is the absence of a sort, so picking it clears the parameter.
  const pickSort = (value: string) =>
    setParams({ sort: value === 'relevance' ? '' : value });
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

  /** Every filter is in the URL: push the next query (shareable, and Back undoes it). */
  const pushQuery = useCallback(
    (next: URLSearchParams) => router.push(`/products?${next.toString()}`),
    [router],
  );
  const toggle = (facet: RailFacet, value: string) => pushQuery(withValueToggled(searchParams, facet, value));
  const removeChip = (chip: AppliedFilter) => pushQuery(withChipRemoved(searchParams, chip));
  const clearRail = () => pushQuery(withRailCleared(searchParams));
  const closeSheet = useCallback(() => setSheetOpen(false), []);

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

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const railCount = railFilterCount(searchParams);
  const activeFilterCount = (category ? 1 : 0) + railCount;

  /** The category list, then the rail — in the desktop sidebar and the mobile sheet alike. */
  const categoryNav = (inSheet: boolean) => (
    <>
      <div className={inSheet ? 'pt-3' : 'mt-4'}>
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
          {/* Departments only; the one in use opens to its subcategories. */}
          {categories.map((root) => (
            <li key={root.id}>
              <button
                onClick={() => setParams({ category: root.slug })}
                className={category === root.slug ? 'font-semibold text-brand-600' : 'text-gray-600 hover:text-brand-600'}
              >
                {root.name}
              </button>
              {(category === root.slug || root.children.some((c) => c.slug === category)) && (
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
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );

  const renderFilters = (inSheet: boolean) =>
    data ? (
      <FilterRail
        rail={data.rail}
        onToggle={toggle}
        onPrice={(lo, hi) => setParams({ minPrice: lo ? String(lo) : '', maxPrice: hi ? String(hi) : '' })}
        before={categoryNav(inSheet)}
      />
    ) : (
      categoryNav(inSheet)
    );

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* ---------------- Filter rail: a sidebar from laptop width up ---------------- */}
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Filters</h2>
            {railCount > 0 && (
              <button onClick={clearRail} className="text-xs font-semibold text-brand-600 hover:underline">
                Clear all
              </button>
            )}
          </div>
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
            {/* Desktop sort (phone and tablet use the bar below) */}
            <select
              aria-label="Sort"
              value={sortValue}
              onChange={(e) => pickSort(e.target.value)}
              className="hidden rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm outline-none lg:block"
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* ---------------- Mobile filter chip bar ---------------- */}
          <div className="sticky top-[var(--header-h,108px)] z-10 -mx-4 mt-3 flex items-center gap-2 overflow-x-auto border-b border-gray-100 bg-cream-50/95 px-4 py-2 backdrop-blur lg:hidden">
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
              aria-label="Sort"
              value={sortValue}
              onChange={(e) => pickSort(e.target.value)}
              className="shrink-0 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-ink-900 outline-none"
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {railCount > 0 && (
              <button
                onClick={clearRail}
                className="shrink-0 rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-sm text-gray-600"
              >
                Clear ✕
              </button>
            )}
          </div>

          {data && <AppliedFilters applied={data.rail.applied} onRemove={removeChip} onClearAll={clearRail} />}

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
                  ? // The guess can be a subcategory ("Headphones"), not only a department.
                    (categories
                      .flatMap((root) => [root, ...root.children])
                      .find((c) => c.slug === data.search!.parsed.filters.inferredCategorySlug)?.name ?? null)
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

      {/* ---------------- Phone / tablet: the rail as a bottom sheet ---------------- */}
      <FilterSheet
        open={sheetOpen}
        onClose={closeSheet}
        onClearAll={clearRail}
        applied={railCount}
        total={data?.total ?? null}
      >
        {renderFilters(true)}
      </FilterSheet>
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
