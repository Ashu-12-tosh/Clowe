'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiRequestError } from '@/lib/api';

interface ProductOption {
  id: string;
  title: string;
}

/**
 * AI marketing assistance (Premium plan): honest campaign copy for one of the
 * seller's products — a social post, hashtags, an offer idea and a WhatsApp
 * message — built only from what the listing says.
 */
export default function SellerMarketingPage() {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productId, setProductId] = useState('');
  const [goal, setGoal] = useState('');
  const [copy, setCopy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ id: string; title: string }[]>('/api/seller/billing/plan/products', { auth: true })
      .then((rows) => {
        setProducts(rows);
        setProductId(rows[0]?.id ?? '');
      })
      .catch(() => {});
  }, []);

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ copy: string }>('/api/ai/marketing', { auth: true, quiet: true, body: { productId, goal: goal.trim() || undefined } });
      setCopy(r.copy);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not write the copy');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">AI marketing assistant</h1>
        <p className="mt-1 text-sm text-gray-500">
          Campaign copy for your products, from what your listing says — with the{' '}
          <Link href="/seller/plans" className="font-semibold text-brand-600 hover:underline">
            Premium plan
          </Link>
          . Check it before you use it.
        </p>
      </div>
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <section className="space-y-3 rounded-2xl border border-gray-100 bg-white p-4">
        <label className="block text-xs font-semibold text-gray-700">
          Product
          <select name="productId" value={productId} onChange={(e) => setProductId(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-gray-700">
          What do you want? (optional)
          <input name="goal" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={200} placeholder="e.g. Diwali weekend sale" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <button onClick={() => void generate()} disabled={busy || !productId} className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white disabled:opacity-50">
          {busy ? 'Writing…' : 'Write the copy'}
        </button>
        {copy && <pre className="whitespace-pre-wrap rounded-lg bg-cream-50 p-3 text-sm text-ink-900" data-marketing-copy>{copy}</pre>}
      </section>
    </div>
  );
}
