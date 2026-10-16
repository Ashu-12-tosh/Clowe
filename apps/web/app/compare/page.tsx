'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { CompareView } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { toggleCompare } from '@/lib/compare';
import ProductCard from '@/components/ProductCard';
import { trackAd, useAds } from '@/components/AdSlots';

interface Delivery {
  serviceable: boolean;
  message: string | null;
  options: { label: string; etaFrom: string; etaTo: string }[];
}

/**
 * Compare up to four products side by side, from our catalog's own data; an
 * optional AI summary written only from those rows.
 */
function ComparePage() {
  const params = useSearchParams();
  const router = useRouter();
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean).slice(0, 4), [params]);
  const [view, setView] = useState<CompareView | null>(null);
  const [needs, setNeeds] = useState('');
  const [summary, setSummary] = useState<{ summary: string | null; message: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState('');
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const ads = useAds(ids.length ? 'COMPARE' : null, { productId: ids[0] });

  useEffect(() => {
    if (!ids.length) return setView({ products: [], attributeLabels: [] });
    api<CompareView>(`/api/ai/compare?ids=${ids.join(',')}`).then(setView).catch(() => setView({ products: [], attributeLabels: [] }));
  }, [ids]);

  async function summarise() {
    setBusy(true);
    try {
      setSummary(await api<{ summary: string | null; message: string | null }>('/api/ai/compare-summary', { method: 'POST', body: { ids, needs: needs.trim() || undefined } }));
    } catch {
      setSummary({ summary: null, message: 'The summary is not available right now.' });
    } finally {
      setBusy(false);
    }
  }

  async function checkPin() {
    if (!/^\d{6}$/.test(pin)) return;
    setDelivery(await api<Delivery>(`/api/delivery/options?pincode=${pin}`).catch(() => null));
  }

  const remove = (id: string) => {
    toggleCompare(id);
    router.replace(`/compare?ids=${ids.filter((x) => x !== id).join(',')}`);
  };

  const products = view?.products ?? [];
  const cell = 'border-t border-gray-100 px-3 py-2 align-top text-sm';
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="font-display text-2xl font-bold text-ink-900">Compare products</h1>
      {!view ? (
        <p className="mt-4 text-sm text-gray-500">Loading…</p>
      ) : products.length < 2 ? (
        <p className="mt-4 text-sm text-gray-600">
          Pick two to four products with “⇄ Compare” on their pages, then come back here. <Link href="/products" className="font-semibold text-brand-600 hover:underline">Browse products</Link>
        </p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto rounded-2xl border border-gray-100 bg-white" data-compare-table>
            <table className="w-full min-w-[640px] table-fixed">
              <thead>
                <tr>
                  <th className="w-36 px-3 py-2 text-left text-xs font-semibold text-gray-500" />
                  {products.map((p) => (
                    <th key={p.id} className="px-3 py-3 text-left align-top">
                      <Link href={`/products/${p.slug}`} className="block">
                        {p.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.imageUrl} alt="" className="aspect-square w-full max-w-[160px] rounded-xl object-cover" />
                        )}
                        <span className="mt-2 line-clamp-2 block text-sm font-semibold text-ink-900">{p.title}</span>
                      </Link>
                      <button type="button" onClick={() => remove(p.id)} className="mt-1 text-[11px] text-gray-500 hover:underline">
                        Remove
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={`${cell} font-semibold text-gray-500`}>Price (GST incl.)</td>
                  {products.map((p) => (
                    <td key={p.id} className={cell}>
                      <span className="font-bold text-ink-900">{p.priceVaries ? 'from ' : ''}{formatPaise(p.pricePaise)}</span>
                      {p.mrpPaise && p.mrpPaise > p.pricePaise && <span className="ml-1 text-xs text-gray-400 line-through">{formatPaise(p.mrpPaise)}</span>}
                    </td>
                  ))}
                </tr>
                {[
                  ['Brand', (p: (typeof products)[number]) => p.brand ?? '—'],
                  ['Rating', (p: (typeof products)[number]) => (p.ratingCount ? `★ ${p.ratingAvg?.toFixed(1)} (${p.ratingCount})` : 'No ratings yet')],
                  ['Seller', (p: (typeof products)[number]) => p.sellerName],
                  ['Returns', (p: (typeof products)[number]) => p.returns],
                  ['In stock', (p: (typeof products)[number]) => (p.inStock ? 'Yes' : 'No')],
                ].map(([label, get]) => (
                  <tr key={label as string}>
                    <td className={`${cell} font-semibold text-gray-500`}>{label as string}</td>
                    {products.map((p) => (
                      <td key={p.id} className={cell}>
                        {(get as (x: typeof p) => string)(p)}
                      </td>
                    ))}
                  </tr>
                ))}
                {view.attributeLabels.map((label) => (
                  <tr key={label}>
                    <td className={`${cell} font-semibold text-gray-500`}>{label}</td>
                    {products.map((p) => (
                      <td key={p.id} className={cell}>
                        {p.attributes[label] ?? '—'}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td className={`${cell} font-semibold text-gray-500`}>Delivery</td>
                  <td className={cell} colSpan={products.length}>
                    <span className="flex flex-wrap items-center gap-2">
                      <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Your PIN code" inputMode="numeric" className="w-32 rounded-lg border border-gray-200 px-2 py-1 text-sm" name="pincode" />
                      <button type="button" onClick={() => void checkPin()} className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-semibold">
                        Check
                      </button>
                      {delivery && (
                        <span className="text-xs text-gray-700">
                          {delivery.serviceable && delivery.options[0]
                            ? `Free delivery ${new Date(delivery.options[0].etaFrom).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}–${new Date(delivery.options[0].etaTo).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, the same for all of these`
                            : (delivery.message ?? 'We do not deliver to this PIN code yet.')}
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <section className="mt-5 rounded-2xl border border-gray-100 bg-white p-4" data-compare-ai>
            <h2 className="text-sm font-bold text-ink-900">✨ Which is better for me?</h2>
            <p className="text-xs text-gray-500">An AI summary written only from the details above — it never adds specs or prices of its own.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input value={needs} onChange={(e) => setNeeds(e.target.value)} maxLength={300} placeholder="What matters to you? e.g. battery life, under ₹2,000" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm" name="needs" />
              <button type="button" disabled={busy} onClick={() => void summarise()} className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Thinking…' : 'Ask'}
              </button>
            </div>
            {summary && <p className="mt-3 whitespace-pre-line text-sm text-ink-900">{summary.summary ?? summary.message}</p>}
          </section>

          {ads.items.length > 0 && (
            <section className="mt-6" aria-label="Sponsored">
              <h2 className="text-sm font-bold text-ink-900">You could also compare</h2>
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                {ads.items.map((ad) => (
                  <ProductCard key={`${ad.campaignId}-${ad.product.id}`} product={ad.product} inWishlist={false} sponsored={ad.label} onNavigate={() => trackAd({ ...ad, productId: ad.product.id })} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-7xl px-4 py-6 text-sm text-gray-500">Loading…</main>}>
      <ComparePage />
    </Suspense>
  );
}
