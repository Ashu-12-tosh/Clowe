'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SellerProductListItem } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const statusStyles: Record<string, string> = {
  APPROVED: 'bg-green-100 text-green-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
  REJECTED: 'bg-red-100 text-red-700',
  DRAFT: 'bg-gray-100 text-gray-600',
};

export default function SellerProductsPage() {
  const [items, setItems] = useState<SellerProductListItem[] | null>(null);

  const load = () => {
    api<SellerProductListItem[]>('/api/seller/products', { auth: true })
      .then(setItems)
      .catch(() => setItems([]));
  };
  useEffect(load, []);

  async function archive(id: string) {
    if (!window.confirm('Archive this product? It will be removed from the store.')) return;
    await api(`/api/seller/products/${id}`, { method: 'DELETE', auth: true });
    load();
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">My Products</h1>
        <Link
          href="/seller/products/new"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          + Add product
        </Link>
      </div>

      {items === null && <p className="mt-6 text-sm text-gray-500">Loading…</p>}

      {items && items.length === 0 && (
        <p className="mt-6 text-sm text-gray-600">
          No products yet. Add your first product to get started.
        </p>
      )}

      {items && items.length > 0 && (
        <div className="mt-4 space-y-3">
          {items.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-3"
            >
              {p.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.imageUrl} alt="" className="h-16 w-12 rounded-lg object-cover" />
              ) : (
                <div className="h-16 w-12 rounded-lg bg-gray-100" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{p.title}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {p.categoryName} · {p.variantCount} variants · stock {p.totalStock} · from{' '}
                  {formatPaise(p.minPricePaise)}
                </p>
                {p.status === 'REJECTED' && p.rejectionReason && (
                  <p className="mt-0.5 text-xs text-red-600">Reason: {p.rejectionReason}</p>
                )}
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[p.status] ?? ''}`}
              >
                {p.status}
              </span>
              <div className="flex shrink-0 gap-2 text-sm">
                <Link
                  href={`/seller/products/${p.id}/edit`}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 hover:bg-gray-50"
                >
                  Edit
                </Link>
                <button
                  onClick={() => void archive(p.id)}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-red-600 hover:bg-red-50"
                >
                  Archive
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
