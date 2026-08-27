'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AddonProduct, CartView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BADGES_EVENT } from '@/components/Header';

interface Props {
  /** Products already in the cart — never offered as an add-on. */
  excludeIds: string[];
  onCartChange: (cart: CartView) => void;
}

/** "Frequently bought together" — cheap add-ons, one tap to add. */
export default function FrequentlyBought({ excludeIds, onCartChange }: Props) {
  const [addons, setAddons] = useState<AddonProduct[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const exclude = excludeIds.join(',');
  useEffect(() => {
    api<AddonProduct[]>(`/api/products/addons?limit=4&exclude=${exclude}`)
      .then(setAddons)
      .catch(() => {});
  }, [exclude]);

  async function add(addon: AddonProduct) {
    setBusyId(addon.id);
    setError('');
    try {
      const cart = await api<CartView>('/api/cart/items', {
        body: { variantId: addon.variantId, quantity: 1 },
        auth: true,
      });
      onCartChange(cart);
      window.dispatchEvent(new Event(BADGES_EVENT));
      setAddons((prev) => prev.filter((a) => a.id !== addon.id));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add that item');
    } finally {
      setBusyId(null);
    }
  }

  if (addons.length === 0) return null;

  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
      <h2 className="text-base font-bold text-ink-900">Frequently bought together</h2>
      {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}
      <div className="mt-3 flex items-stretch gap-2 overflow-x-auto pb-1">
        {addons.map((addon, i) => (
          <div key={addon.id} className="flex items-stretch gap-2">
            {i > 0 && <span className="self-center text-lg text-gray-300">+</span>}
            <div className="flex w-56 shrink-0 items-center gap-3 rounded-xl border border-gray-200 p-2.5">
              <Link href={`/products/${addon.slug}`} className="shrink-0">
                {addon.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={addon.imageUrl}
                    alt=""
                    loading="lazy"
                    className="h-14 w-14 rounded-lg bg-cream-100 object-cover"
                  />
                ) : (
                  <div className="h-14 w-14 rounded-lg bg-cream-100" />
                )}
              </Link>
              <div className="min-w-0 flex-1">
                <Link
                  href={`/products/${addon.slug}`}
                  className="line-clamp-2 text-xs font-semibold text-ink-900 hover:text-brand-600"
                >
                  {addon.title}
                </Link>
                <p className="mt-0.5 text-xs font-bold text-ink-900">
                  {formatPaise(addon.pricePaise)}
                </p>
                <button
                  onClick={() => void add(addon)}
                  disabled={busyId === addon.id}
                  className="mt-1.5 rounded-md border border-brand-600 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-brand-600 transition hover:bg-brand-50 disabled:opacity-50"
                >
                  {busyId === addon.id ? 'Adding…' : 'Add'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
