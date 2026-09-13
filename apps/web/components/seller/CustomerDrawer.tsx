'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CUSTOMER_SEGMENT_RULES,
  type CustomerSegment,
  type CustomerStatus,
  type SellerCustomerDetail,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

export const SEGMENT_STYLES: Record<CustomerSegment, string> = {
  HIGH_VALUE: 'bg-brand-100 text-brand-700',
  REPEAT: 'bg-purple-100 text-purple-700',
  REGULAR: 'bg-blue-100 text-blue-700',
  AT_RISK: 'bg-red-100 text-red-700',
  NEW: 'bg-green-100 text-green-700',
};

export const CUSTOMER_STATUS_STYLES: Record<CustomerStatus, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  AT_RISK: 'bg-red-100 text-red-700',
  DORMANT: 'bg-gray-100 text-gray-600',
};

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-cream-50 p-3">
      <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-0.5 font-display text-base font-bold text-ink-900">{value}</p>
    </div>
  );
}

export default function CustomerDrawer({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SellerCustomerDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<SellerCustomerDetail>(`/api/seller/customers/${userId}`, { auth: true })
      .then(setDetail)
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load this customer'),
      );
  }, [userId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-900/40" onClick={onClose}>
      <aside
        className="h-full w-full max-w-lg overflow-y-auto bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 flex items-start justify-between border-b border-gray-100 bg-white px-5 py-4">
          <div className="min-w-0">
            <p className="truncate font-display text-lg font-bold text-ink-900">
              {detail?.name ?? 'Loading…'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full px-3 py-1 text-sm text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </header>

        {error && <p className="mx-5 mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!detail && !error && <p className="p-5 text-sm text-gray-500">Loading…</p>}

        {detail && (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${SEGMENT_STYLES[detail.segment]}`}
                title={CUSTOMER_SEGMENT_RULES[detail.segment]}
              >
                {detail.segmentLabel}
              </span>
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${CUSTOMER_STATUS_STYLES[detail.status]}`}
              >
                {detail.statusLabel}
              </span>
              {detail.city && (
                <span className="rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600">
                  {detail.city}
                  {detail.state ? `, ${detail.state}` : ''}
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-400">{CUSTOMER_SEGMENT_RULES[detail.segment]}</p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Lifetime value" value={formatPaise(detail.ltvPaise)} />
              <Stat label="Orders" value={detail.orderCount} />
              <Stat label="Avg order" value={formatPaise(detail.avgOrderValuePaise)} />
              <Stat label="Returns" value={`${detail.returnCount} (${detail.returnRate}%)`} />
            </div>

            <div className="rounded-2xl border border-gray-100 p-4 text-xs">
              <div className="flex justify-between py-1">
                <span className="text-gray-500">First order from you</span>
                <span className="text-ink-900">
                  {new Date(detail.firstOrderAt).toLocaleDateString('en-IN')}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-gray-500">Last order</span>
                <span className="text-ink-900">
                  {new Date(detail.lastOrderAt).toLocaleDateString('en-IN')} ·{' '}
                  {detail.daysSinceLastOrder}d ago
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-gray-500">On Clowe since</span>
                <span className="text-ink-900">
                  {new Date(detail.joinedAt).toLocaleDateString('en-IN')}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-gray-500">Units bought</span>
                <span className="text-ink-900">{detail.unitsBought}</span>
              </div>
            </div>

            {detail.topCategories.length > 0 && (
              <div className="rounded-2xl border border-gray-100 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  What they buy from you
                </h3>
                <ul className="mt-2 space-y-1.5 text-xs">
                  {detail.topCategories.map((c) => (
                    <li key={c.name} className="flex items-center justify-between gap-2">
                      <span className="text-gray-700">{c.name}</span>
                      <span className="text-gray-400">
                        {c.unitsBought} units ·{' '}
                        <span className="font-semibold text-ink-900">
                          {formatPaise(c.spentPaise)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-2xl border border-gray-100 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Orders with your shop
              </h3>
              <table className="mt-2 w-full text-xs">
                <tbody>
                  {detail.orders.map((o) => (
                    <tr key={o.orderId} className="border-t border-gray-50">
                      <td className="py-1.5 font-mono text-brand-600">{o.orderNumber}</td>
                      <td className="py-1.5 text-gray-500">
                        {new Date(o.placedAt).toLocaleDateString('en-IN')}
                      </td>
                      <td className="py-1.5 text-gray-500">{o.itemCount} item(s)</td>
                      <td className="py-1.5 text-right font-semibold text-ink-900">
                        {formatPaise(o.amountPaise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Link
                href="/seller/orders"
                className="mt-2 inline-block text-[11px] font-semibold text-brand-600 hover:underline"
              >
                Open in orders →
              </Link>
            </div>

            {detail.returns.length > 0 && (
              <div className="rounded-2xl border border-gray-100 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  Return history
                </h3>
                <ul className="mt-2 space-y-1.5 text-xs">
                  {detail.returns.map((r) => (
                    <li key={r.id}>
                      <Link href={`/seller/returns/${r.id}`} className="hover:text-brand-600">
                        <span className="font-mono text-gray-600">{r.orderNumber}</span> ·{' '}
                        {r.title} — {r.reasonLabel}
                        <span className="ml-1 text-gray-400">({r.status})</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
