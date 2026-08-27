'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  PRODUCT_SORT_LABELS,
  productSortValues,
  type CategoryCallout,
  type CategoryDetail,
  type ProductListResponse,
  type ProductSort,
} from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import { formatPaise } from '@/lib/format';
import CategoryHero from '@/components/category/CategoryHero';
import CategoryProductCard from '@/components/category/CategoryProductCard';
import PriceRangeSlider from '@/components/PriceRangeSlider';
import { trackAdClick, useSponsoredAds } from '@/components/SponsoredAds';
import { ChevronIcon } from '@/components/cart/CartIcons';

const PAGE_SIZE = 24;
/** Category/brand lists collapse past this many rows until "View More". */
const FACET_PREVIEW = 8;
/** Hero slides advance on their own; pausing on hover keeps reading possible. */
const CAROUSEL_MS = 6000;

/** Used when a category has no feature strip configured. */
const DEFAULT_FEATURES: CategoryCallout[] = [
  { icon: '⭐', title: 'Top Brands', subtitle: 'Handpicked, all in one place.' },
  { icon: '🏷', title: 'Unbeatable Deals', subtitle: 'Best prices on top products.' },
  { icon: '🛡', title: 'Secure Payments', subtitle: '100% safe & secure.' },
  { icon: '↩', title: 'Easy Returns', subtitle: 'Hassle-free return policy.' },
];

/** Collapsible sidebar group. */
function FilterGroup({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-gray-100 py-3.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-sm font-bold text-ink-900"
      >
        {title}
        <ChevronIcon className="h-4 w-4 text-gray-400" open={open} />
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** Horizontal subcategory rail with scroll arrows. */
function SubcategoryRail({
  category,
  selected,
}: {
  category: CategoryDetail;
  selected: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const scrollBy = (dir: 1 | -1) =>
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: 'smooth' });

  if (category.children.length === 0) return null;
  const round = category.tileShape === 'circle';

  return (
    <div className="group relative mt-5">
      <div
        ref={ref}
        className="scrollbar-none flex gap-3 overflow-x-auto scroll-smooth pb-1"
      >
        {category.children.map((child) => {
          const active = selected === child.slug;
          return (
            <Link
              key={child.id}
              href={
                active
                  ? `/category/${category.slug}`
                  : `/category/${category.slug}?category=${child.slug}`
              }
              className={`flex w-28 shrink-0 flex-col items-center gap-2 p-3 transition hover:-translate-y-0.5 ${
                round
                  ? ''
                  : `rounded-2xl border bg-white hover:shadow-md ${
                      active ? 'border-brand-600' : 'border-gray-100 hover:border-brand-600'
                    }`
              }`}
            >
              <span
                className={`flex h-16 w-16 items-center justify-center overflow-hidden bg-cream-100 ${
                  round ? 'rounded-full' : 'rounded-xl'
                } ${active && round ? 'ring-2 ring-brand-600 ring-offset-2' : ''}`}
              >
                {child.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={child.imageUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-2xl">🛍</span>
                )}
              </span>
              <span
                className={`text-center text-xs leading-tight ${
                  active ? 'font-bold text-brand-600' : 'font-semibold text-ink-900'
                }`}
              >
                {child.name}
              </span>
            </Link>
          );
        })}
      </div>
      <button
        onClick={() => scrollBy(-1)}
        aria-label="Scroll left"
        className="absolute -left-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-gray-200 bg-white shadow-md transition hover:border-brand-600 lg:group-hover:flex"
      >
        ‹
      </button>
      <button
        onClick={() => scrollBy(1)}
        aria-label="Scroll right"
        className="absolute -right-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-gray-200 bg-white shadow-md transition hover:border-brand-600 lg:group-hover:flex"
      >
        ›
      </button>
    </div>
  );
}

function CategoryPageInner() {
  const params = useParams<{ slug: string }>();
  const rootSlug = params.slug;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [category, setCategory] = useState<CategoryDetail | null>(null);
  const [data, setData] = useState<ProductListResponse | null>(null);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [brandQuery, setBrandQuery] = useState('');
  const [showAllCats, setShowAllCats] = useState(false);
  const [showAllBrands, setShowAllBrands] = useState(false);

  // `category` here is the *selected* subcategory (falls back to the root).
  const selectedCategory = searchParams.get('category') ?? rootSlug;
  const brands = (searchParams.get('brands') ?? '').split(',').filter(Boolean);
  const minPrice = searchParams.get('minPrice') ?? '';
  const maxPrice = searchParams.get('maxPrice') ?? '';
  const sort = (searchParams.get('sort') ?? 'popularity') as ProductSort;
  const page = Number(searchParams.get('page') ?? '1');

  const sponsoredAds = useSponsoredAds(page === 1 ? 'CATEGORY_SPONSORED' : null, selectedCategory);
  const adProductIds = new Set(sponsoredAds.map((ad) => ad.product.id));
  const organicItems = (data?.items ?? []).filter((p) => !adProductIds.has(p.id));

  /** Update query params on this category route (resets paging). */
  const setParams = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      if (!('page' in updates)) next.delete('page');
      for (const [key, value] of Object.entries(updates)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const query = next.toString();
      router.push(`/category/${rootSlug}${query ? `?${query}` : ''}`);
    },
    [router, searchParams, rootSlug],
  );

  useEffect(() => {
    setNotFound(false);
    api<CategoryDetail>(`/api/categories/${rootSlug}`)
      .then(setCategory)
      .catch(() => setNotFound(true));
    fetchWishlistIds().then(setWishlistIds);
  }, [rootSlug]);

  useEffect(() => {
    setLoading(true);
    setError('');
    const query = new URLSearchParams(searchParams.toString());
    query.set('category', selectedCategory);
    query.set('limit', String(PAGE_SIZE));
    if (!query.get('sort')) query.set('sort', 'popularity');
    api<ProductListResponse>(`/api/products?${query.toString()}`)
      .then(setData)
      .catch(() => setError('Could not load products. Is the API running?'))
      .finally(() => setLoading(false));
  }, [searchParams, selectedCategory]);

  useEffect(() => {
    document.body.style.overflow = sheetOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [sheetOpen]);

  const toggleBrand = (name: string) => {
    const next = brands.includes(name) ? brands.filter((b) => b !== name) : [...brands, name];
    setParams({ brands: next.join(',') });
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const activeFilterCount =
    brands.length + (selectedCategory !== rootSlug ? 1 : 0) + (minPrice || maxPrice ? 1 : 0);
  const firstItem = data ? (page - 1) * data.limit + 1 : 0;
  const lastItem = data ? Math.min(page * data.limit, data.total) : 0;

  const features = category?.features.length ? category.features : DEFAULT_FEATURES;
  const catFacets = data?.facets.categories ?? [];
  const brandFacets = (data?.facets.brands ?? []).filter((b) =>
    b.name.toLowerCase().includes(brandQuery.trim().toLowerCase()),
  );

  const renderFilters = () => (
    <>
      <FilterGroup title="Categories">
        <ul className="space-y-2 text-sm">
          <li>
            <label className="flex cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={selectedCategory === rootSlug}
                onChange={() => setParams({ category: '' })}
                className="h-4 w-4 accent-brand-600"
              />
              <span
                className={
                  selectedCategory === rootSlug ? 'font-semibold text-ink-900' : 'text-gray-600'
                }
              >
                All {category?.name ?? ''}
              </span>
              {data && <span className="ml-auto text-xs text-gray-400">({category?.productCount ?? 0})</span>}
            </label>
          </li>
          {(showAllCats ? catFacets : catFacets.slice(0, FACET_PREVIEW)).map((cat) => (
            <li key={cat.slug}>
              <label className="flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={selectedCategory === cat.slug}
                  onChange={() =>
                    setParams({ category: selectedCategory === cat.slug ? '' : cat.slug })
                  }
                  className="h-4 w-4 accent-brand-600"
                />
                <span
                  className={
                    selectedCategory === cat.slug
                      ? 'font-semibold text-ink-900'
                      : 'text-gray-600 hover:text-brand-600'
                  }
                >
                  {cat.name}
                </span>
                <span className="ml-auto text-xs text-gray-400">({cat.count})</span>
              </label>
            </li>
          ))}
        </ul>
        {catFacets.length > FACET_PREVIEW && (
          <button
            onClick={() => setShowAllCats((v) => !v)}
            className="mt-2.5 flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
          >
            {showAllCats ? '− View Less' : '+ View More'}
          </button>
        )}
      </FilterGroup>

      <FilterGroup title="Brands">
        <input
          value={brandQuery}
          onChange={(e) => setBrandQuery(e.target.value)}
          placeholder="Search brands..."
          aria-label="Search brands"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
        />
        <ul className="mt-2.5 space-y-2 text-sm">
          {(showAllBrands ? brandFacets : brandFacets.slice(0, FACET_PREVIEW)).map((brand) => (
            <li key={brand.name}>
              <label className="flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={brands.includes(brand.name)}
                  onChange={() => toggleBrand(brand.name)}
                  className="h-4 w-4 accent-brand-600"
                />
                <span
                  className={
                    brands.includes(brand.name)
                      ? 'font-semibold text-ink-900'
                      : 'text-gray-600 hover:text-brand-600'
                  }
                >
                  {brand.name}
                </span>
                <span className="ml-auto text-xs text-gray-400">({brand.count})</span>
              </label>
            </li>
          ))}
          {brandFacets.length === 0 && (
            <li className="text-xs text-gray-400">No brands match “{brandQuery}”.</li>
          )}
        </ul>
        {brandFacets.length > FACET_PREVIEW && (
          <button
            onClick={() => setShowAllBrands((v) => !v)}
            className="mt-2.5 text-xs font-semibold text-brand-600 hover:underline"
          >
            {showAllBrands ? '− View Less' : '+ View More'}
          </button>
        )}
      </FilterGroup>

      {data?.facets.priceRange && (
        <FilterGroup title="Price">
          <PriceRangeSlider
            min={Math.floor(data.facets.priceRange.minPaise / 100)}
            max={Math.ceil(data.facets.priceRange.maxPaise / 100)}
            valueMin={minPrice ? Number(minPrice) : null}
            valueMax={maxPrice ? Number(maxPrice) : null}
            onApply={(lo, hi) =>
              setParams({ minPrice: lo ? String(lo) : '', maxPrice: hi ? String(hi) : '' })
            }
          />
          {(minPrice || maxPrice) && (
            <p className="mt-2 text-xs text-gray-500">
              Showing {minPrice ? formatPaise(Number(minPrice) * 100) : '₹0'} –{' '}
              {maxPrice ? formatPaise(Number(maxPrice) * 100) : 'any'}
            </p>
          )}
        </FilterGroup>
      )}
    </>
  );

  if (notFound) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <h1 className="font-display text-2xl font-bold text-ink-900">Category not found</h1>
        <Link
          href="/products"
          className="mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          Browse all products
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-10 pt-4">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">{category?.name ?? '…'}</span>
      </nav>

      {/* Title + hero */}
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:items-center">
        <div>
          <h1 className="t-page-title text-ink-900">{category?.name ?? ' '}</h1>
          {category?.description && (
            <p className="t-section-desc mt-2 text-gray-500">{category.description}</p>
          )}
        </div>

        {category && (
          <CategoryHero
            slides={category.banners}
            highlights={category.highlights}
            intervalMs={CAROUSEL_MS}
          />
        )}
      </div>

      {category && <SubcategoryRail category={category} selected={selectedCategory} />}

      <div id="products" className="mt-6 grid items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* ── Filters (desktop) ─────────────────────────────────────────── */}
        <aside className="hidden rounded-2xl border border-gray-100 bg-white px-4 py-3 lg:block">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-ink-900">Filter</h2>
            {activeFilterCount > 0 && (
              <Link
                href={`/category/${rootSlug}`}
                className="text-xs font-semibold text-brand-600 hover:underline"
              >
                Clear All
              </Link>
            )}
          </div>
          {renderFilters()}
        </aside>

        {/* ── Results ───────────────────────────────────────────────────── */}
        <section className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500">
              {data
                ? `Showing ${data.total === 0 ? 0 : firstItem}-${lastItem} of ${data.total} products`
                : 'Loading…'}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">Sort by:</span>
              <select
                value={sort}
                onChange={(e) => setParams({ sort: e.target.value })}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-brand-600"
              >
                {productSortValues.map((value) => (
                  <option key={value} value={value}>
                    {PRODUCT_SORT_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Mobile filter bar */}
          <div className="mt-3 flex items-center gap-2 lg:hidden">
            <button
              onClick={() => setSheetOpen(true)}
              className={`flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold ${
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
            {activeFilterCount > 0 && (
              <Link
                href={`/category/${rootSlug}`}
                className="rounded-full border border-gray-300 bg-white px-4 py-2 text-sm text-gray-600"
              >
                Clear ✕
              </Link>
            )}
          </div>

          {/* Active brand chips */}
          {brands.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {brands.map((brand) => (
                <button
                  key={brand}
                  onClick={() => toggleBrand(brand)}
                  className="flex items-center gap-1.5 rounded-full border border-brand-600 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700"
                >
                  {brand} ✕
                </button>
              ))}
            </div>
          )}

          {error && (
            <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {loading && !data && (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-72 animate-pulse rounded-2xl bg-cream-100" />
              ))}
            </div>
          )}

          {data && data.items.length === 0 && sponsoredAds.length === 0 && (
            <div className="mt-12 text-center">
              <p className="text-sm text-gray-500">No products match these filters.</p>
              <Link
                href={`/category/${rootSlug}`}
                className="mt-3 inline-block text-sm font-semibold text-brand-600 hover:underline"
              >
                Clear all filters
              </Link>
            </div>
          )}

          {data && (data.items.length > 0 || sponsoredAds.length > 0) && (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {sponsoredAds.map((ad) => (
                <CategoryProductCard
                  key={`ad-${ad.id}`}
                  product={ad.product}
                  inWishlist={wishlistIds.has(ad.product.id)}
                  sponsored
                  onNavigate={() => trackAdClick(ad.id)}
                />
              ))}
              {organicItems.map((product) => (
                <CategoryProductCard
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
                className="rounded-lg border border-gray-300 px-4 py-2 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span className="text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setParams({ page: String(page + 1) })}
                className="rounded-lg border border-gray-300 px-4 py-2 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}

          {/* Feature strip */}
          <section className="mt-8 grid gap-4 rounded-2xl bg-cream-50 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {features.map((feature) => (
              <div key={feature.title} className="flex items-start gap-2.5">
                <span className="mt-0.5 text-xl leading-none text-brand-600">{feature.icon}</span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink-900">{feature.title}</p>
                  <p className="text-xs text-gray-500">{feature.subtitle}</p>
                </div>
              </div>
            ))}
          </section>
        </section>
      </div>

      {/* Mobile filter sheet */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setSheetOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-3xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
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
            <div className="flex-1 overflow-y-auto px-5 pb-4">{renderFilters()}</div>
            <div className="flex gap-3 border-t border-gray-100 px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
              <button
                onClick={() => {
                  setSheetOpen(false);
                  router.push(`/category/${rootSlug}`);
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

export default function CategoryPage() {
  return (
    <Suspense>
      <CategoryPageInner />
    </Suspense>
  );
}
