'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AiSearchResult, ProductListItem } from '@clowe/shared';
import { api } from '@/lib/api';
import { fetchWishlistIds } from '@/lib/wishlist';
import ProductCard from '@/components/ProductCard';
import { CompareButton } from '@/components/CompareBar';
import { adProductIds, trackAd, useAds } from '@/components/AdSlots';

const EXAMPLES = ['Cotton kurta for women under ₹1,500', 'Wireless earbuds with long battery', 'Running shoes for men, size 9'];

/**
 * AI Search: ask in your own words; AI turns the question into filters and one
 * line, and the results are our catalog's own products. Without AI (budget,
 * limit, error), the same words run as a normal search.
 */
function AiSearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const [result, setResult] = useState<AiSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [wishlist, setWishlist] = useState<Set<string>>(new Set());
  const ads = useAds(q.trim().length >= 2 ? 'SEARCH' : null, { q });

  useEffect(() => {
    setDraft(q);
    if (q.trim().length < 2) return setResult(null);
    setLoading(true);
    api<AiSearchResult>(`/api/ai/search?q=${encodeURIComponent(q)}`)
      .then(setResult)
      .catch(() => router.replace(`/products?q=${encodeURIComponent(q)}`)) // never an error page: the normal search
      .finally(() => setLoading(false));
    fetchWishlistIds().then(setWishlist);
  }, [q, router]);

  const paid = adProductIds([...ads.top, ...ads.items]);
  const grid = (items: ProductListItem[]) => (
    <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {items.filter((p) => !paid.has(p.id)).map((p) => (
        <div key={p.id} className="flex flex-col gap-1.5">
          <ProductCard product={p} inWishlist={wishlist.has(p.id)} />
          <CompareButton productId={p.id} className="self-start" />
        </div>
      ))}
    </div>
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="font-display text-2xl font-bold text-ink-900">✨ AI Search</h1>
      <p className="text-sm text-gray-500">Ask in your own words. Results are real products on Clowe — AI only reads your question.</p>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim().length >= 2) router.push(`/ai-search?q=${encodeURIComponent(draft.trim())}`);
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={200} placeholder="What are you looking for?" className="min-w-0 flex-1 rounded-xl border border-gray-200 px-4 py-3 text-sm" name="q" />
        <button type="submit" className="rounded-xl bg-ink-900 px-5 text-sm font-bold text-white">
          Search
        </button>
      </form>
      {!q && (
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <Link key={e} href={`/ai-search?q=${encodeURIComponent(e)}`} className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:border-brand-600">
              {e}
            </Link>
          ))}
        </div>
      )}
      {loading && <p className="mt-6 text-sm text-gray-500">Searching…</p>}
      {result && !loading && (
        <div className="mt-5" data-ai-search>
          {result.ai ? (
            result.answer && <p className="rounded-xl bg-cream-50 px-4 py-3 text-sm text-ink-900" data-ai-answer>{result.answer}</p>
          ) : (
            <p className="rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-600">AI search is resting right now — here are the normal results for your words.</p>
          )}
          {[...ads.top, ...ads.items].length > 0 && (
            <section className="mt-4" aria-label="Sponsored">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {[...ads.top, ...ads.items].map((ad) => (
                  <ProductCard key={`${ad.campaignId}-${ad.product.id}`} product={ad.product} inWishlist={wishlist.has(ad.product.id)} sponsored={ad.label} onNavigate={() => trackAd({ ...ad, productId: ad.product.id })} />
                ))}
              </div>
            </section>
          )}
          {result.items.length > 0 && (
            <section className="mt-5">
              <h2 className="text-sm font-bold text-ink-900">AI picks</h2>
              {grid(result.items)}
            </section>
          )}
          {result.more.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold text-ink-900">{result.items.length ? 'More from all sellers' : 'Results'}</h2>
              {grid(result.more)}
            </section>
          )}
          {result.items.length + result.more.length === 0 && (
            <p className="mt-4 text-sm text-gray-600">
              Nothing on Clowe matches that yet. <Link href={`/products?q=${encodeURIComponent(q)}`} className="font-semibold text-brand-600 hover:underline">Try the normal search</Link>
            </p>
          )}
        </div>
      )}
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-7xl px-4 py-6 text-sm text-gray-500">Loading…</main>}>
      <AiSearchPage />
    </Suspense>
  );
}
