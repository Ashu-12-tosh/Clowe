'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { WEEKDAYS, WEEKDAY_LABELS, type PublicStore, type Weekday } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

interface StoreProductsPage {
  total: number;
  page: number;
  totalPages: number;
  acceptingOrders: boolean;
  items: {
    id: string;
    title: string;
    slug: string;
    brand: string | null;
    imageUrl: string | null;
    pricePaise: number;
    mrpPaise: number | null;
    ratingAvg: number | null;
    ratingCount: number;
  }[];
}

export default function StorePage({ params }: { params: { slug: string } }) {
  const [store, setStore] = useState<PublicStore | null>(null);
  const [products, setProducts] = useState<StoreProductsPage | null>(null);
  const [page, setPage] = useState(1);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api<PublicStore>(`/api/stores/${params.slug}`)
      .then(setStore)
      .catch((err) => {
        if (err instanceof ApiRequestError) setNotFound(true);
      });
  }, [params.slug]);

  useEffect(() => {
    api<StoreProductsPage>(`/api/stores/${params.slug}/products?page=${page}&pageSize=12`)
      .then(setProducts)
      .catch(() => setProducts(null));
  }, [params.slug, page]);

  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-20 text-center">
        <h1 className="font-display text-2xl font-bold text-ink-900">Store not found</h1>
        <p className="mt-2 text-sm text-gray-600">
          This shop may have moved or is not accepting orders right now.
        </p>
        <Link
          href="/products"
          className="mt-4 inline-block rounded-lg bg-ink-900 px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-white"
        >
          Browse all products
        </Link>
      </main>
    );
  }

  if (!store) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-20 text-center text-sm text-gray-500">
        Loading store…
      </main>
    );
  }

  const socials = Object.entries(store.socialLinks).filter(([, url]) => !!url);

  return (
    <main className="pb-16">
      {/* --- Banner --------------------------------------------------- */}
      <div className="h-40 w-full bg-ink-900 sm:h-56">
        {store.bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={store.bannerUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="font-display text-xl font-bold uppercase tracking-[0.2em] text-brand-400">
              {store.shopName}
            </p>
          </div>
        )}
      </div>

      <div className="mx-auto max-w-6xl px-4">
        {/* --- Identity ----------------------------------------------- */}
        <div className="-mt-10 flex flex-wrap items-end gap-4">
          <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-ink-900 font-display text-xl font-bold text-white">
            {store.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={store.logoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              store.shopName.slice(0, 2).toUpperCase()
            )}
          </span>
          <div className="min-w-0 flex-1 pb-1">
            <h1 className="flex flex-wrap items-center gap-2 font-display text-2xl font-bold text-ink-900">
              {store.shopName}
              {store.isVerified && (
                <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">
                  ✓ Verified seller
                </span>
              )}
            </h1>
            <p className="text-sm text-gray-500">
              {store.primaryCategoryName && <>{store.primaryCategoryName} · </>}
              {store.city ?? 'India'}
              {store.state ? `, ${store.state}` : ''} ·{' '}
              {store.ratingAvg != null ? (
                <>
                  ★ {store.ratingAvg} ({store.ratingCount} ratings)
                </>
              ) : (
                'No ratings yet'
              )}
            </p>
          </div>
        </div>

        {store.tagline && <p className="mt-3 font-display text-lg text-ink-900">{store.tagline}</p>}
        {store.description && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-600">
            {store.description}
          </p>
        )}

        {store.vacationMessage && (
          <p className="mt-4 rounded-xl border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
            🌴 {store.vacationMessage}
          </p>
        )}

        {/* --- Highlights --------------------------------------------- */}
        {store.highlights.length > 0 && (
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {store.highlights.slice(0, 4).map((h) => (
              <div key={h.title} className="rounded-2xl border border-gray-100 bg-white p-3">
                <p className="text-lg">{h.icon}</p>
                <p className="mt-1 text-sm font-semibold text-ink-900">{h.title}</p>
                <p className="text-[11px] text-gray-500">{h.subtitle}</p>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-4">
          {/* --- Products ---------------------------------------------- */}
          <div className="lg:col-span-3">
            <div className="flex items-baseline justify-between">
              <h2 className="font-display text-lg font-bold text-ink-900">
                Products {products && <span className="text-gray-400">({products.total})</span>}
              </h2>
            </div>

            {products && products.items.length > 0 ? (
              <>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {products.items.map((p) => (
                    <Link
                      key={p.id}
                      href={`/products/${p.slug}`}
                      className="group overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:border-gray-300"
                    >
                      <div className="aspect-[3/4] w-full bg-cream-100">
                        {p.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.imageUrl}
                            alt={p.title}
                            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                          />
                        )}
                      </div>
                      <div className="p-3">
                        {p.brand && (
                          <p className="text-[11px] uppercase tracking-wide text-gray-400">
                            {p.brand}
                          </p>
                        )}
                        <p className="line-clamp-2 text-sm text-ink-900">{p.title}</p>
                        <p className="mt-1">
                          <span className="font-display text-base font-bold text-ink-900">
                            {formatPaise(p.pricePaise)}
                          </span>
                          {p.mrpPaise && p.mrpPaise > p.pricePaise && (
                            <span className="ml-1.5 text-xs text-gray-400 line-through">
                              {formatPaise(p.mrpPaise)}
                            </span>
                          )}
                        </p>
                        {p.ratingAvg != null && (
                          <p className="mt-0.5 text-[11px] text-gray-500">
                            ★ {p.ratingAvg} ({p.ratingCount})
                          </p>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>

                {products.totalPages > 1 && (
                  <div className="mt-5 flex items-center justify-center gap-3 text-sm">
                    <button
                      disabled={products.page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 font-semibold disabled:opacity-40"
                    >
                      ‹ Previous
                    </button>
                    <span className="text-gray-500">
                      Page {products.page} of {products.totalPages}
                    </span>
                    <button
                      disabled={products.page >= products.totalPages}
                      onClick={() => setPage((p) => p + 1)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 font-semibold disabled:opacity-40"
                    >
                      Next ›
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-4 text-sm text-gray-500">
                This shop has no products on sale right now.
              </p>
            )}
          </div>

          {/* --- About -------------------------------------------------- */}
          <aside className="space-y-4">
            <section className="rounded-2xl border border-gray-100 bg-white p-4">
              <h3 className="text-sm font-bold text-ink-900">Store details</h3>
              <dl className="mt-2 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Selling since</dt>
                  <dd className="text-ink-900">
                    {new Date(store.memberSince).toLocaleDateString('en-IN', {
                      month: 'short',
                      year: 'numeric',
                    })}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Products</dt>
                  <dd className="text-ink-900">{store.productCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Returns</dt>
                  <dd className="text-ink-900">{store.returnWindowDays} days</dd>
                </div>
              </dl>
            </section>

            <section className="rounded-2xl border border-gray-100 bg-white p-4">
              <h3 className="text-sm font-bold text-ink-900">Working hours</h3>
              <ul className="mt-2 space-y-1 text-xs">
                {WEEKDAYS.map((day: Weekday) => {
                  const h = store.workingHours[day];
                  return (
                    <li key={day} className="flex justify-between">
                      <span className="text-gray-500">{WEEKDAY_LABELS[day]}</span>
                      <span className="text-ink-900">
                        {h.closed ? 'Closed' : `${h.open} – ${h.close}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

            {socials.length > 0 && (
              <section className="rounded-2xl border border-gray-100 bg-white p-4">
                <h3 className="text-sm font-bold text-ink-900">Follow this store</h3>
                <ul className="mt-2 space-y-1 text-xs">
                  {socials.map(([key, url]) => (
                    <li key={key}>
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="capitalize text-brand-600 hover:underline"
                      >
                        {key} →
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
