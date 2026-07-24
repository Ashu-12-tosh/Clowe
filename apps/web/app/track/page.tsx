'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { TrackOrderView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const STEPS = ['CONFIRMED', 'SHIPPED', 'DELIVERED'] as const;
const STEP_LABELS: Record<string, string> = {
  CONFIRMED: 'Confirmed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
};

function stepIndex(status: string): number {
  if (status === 'DELIVERED' || status === 'RETURN_REQUESTED' || status === 'RETURNED') return 2;
  if (status === 'SHIPPED') return 1;
  if (status === 'CONFIRMED') return 0;
  return -1; // PLACED / CANCELLED
}

function Timeline({ status }: { status: string }) {
  const current = stepIndex(status);
  return (
    <div className="mt-3 flex items-center">
      {STEPS.map((step, i) => (
        <div key={step} className="flex flex-1 items-center last:flex-none">
          <div className="flex flex-col items-center">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                i <= current ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-400'
              }`}
            >
              {i <= current ? '✓' : i + 1}
            </span>
            <span className="mt-1 text-[10px] text-gray-500">{STEP_LABELS[step]}</span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`mx-1 mb-4 h-0.5 flex-1 ${i < current ? 'bg-green-600' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function TrackPageInner() {
  const params = useSearchParams();
  const [orderNumber, setOrderNumber] = useState(params.get('orderNumber') ?? '');
  const [phone, setPhone] = useState('');
  const [data, setData] = useState<TrackOrderView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function track(e?: React.FormEvent) {
    e?.preventDefault();
    setError('');
    setData(null);
    setBusy(true);
    try {
      const query = new URLSearchParams({ orderNumber: orderNumber.trim(), phone: phone.trim() });
      setData(await api<TrackOrderView>(`/api/track?${query.toString()}`));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // Prefilled from a link — user still needs to enter their phone.
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold">Track your order 🚚</h1>
      <p className="mt-1 text-sm text-gray-600">
        No login needed — enter your order number and the phone number used on the order.
      </p>

      <form onSubmit={(e) => void track(e)} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          value={orderNumber}
          onChange={(e) => setOrderNumber(e.target.value.toUpperCase())}
          placeholder="Order number (CLW-2026-123456)"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600"
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
          maxLength={10}
          placeholder="Phone number"
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600 sm:w-44"
        />
        <button
          disabled={busy || !orderNumber || phone.length !== 10}
          className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Track'}
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {data && (
        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-lg font-bold">{data.orderNumber}</p>
              <p className="text-xs text-gray-500">
                Placed{' '}
                {new Date(data.placedAt).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}{' '}
                · Delivering to {data.shipCity}, {data.shipState} — {data.shipPincode}
              </p>
            </div>
            {data.status === 'CANCELLED' && (
              <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600">
                CANCELLED
              </span>
            )}
            {!data.paid && data.status !== 'CANCELLED' && (
              <span className="rounded-full bg-yellow-100 px-3 py-1 text-xs font-semibold text-yellow-700">
                Payment pending
              </span>
            )}
          </div>

          <div className="mt-4 space-y-4">
            {data.items.map((item, i) => (
              <div key={i} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex gap-3">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" className="h-16 w-12 rounded-lg object-cover" />
                  ) : (
                    <div className="h-16 w-12 rounded-lg bg-gray-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{item.title}</p>
                    <p className="text-xs text-gray-500">
                      {item.color} / {item.size} · qty {item.quantity}
                    </p>
                    {item.courierName && (
                      <p className="mt-0.5 text-xs text-gray-600">
                        via <span className="font-medium">{item.courierName}</span> · AWB{' '}
                        <span className="font-mono">{item.awbNumber}</span>
                      </p>
                    )}
                  </div>
                </div>
                {item.status === 'CANCELLED' ? (
                  <p className="mt-2 text-xs font-semibold text-gray-500">Cancelled</p>
                ) : (
                  <Timeline status={item.status} />
                )}
                <div className="mt-1 flex gap-4 text-[11px] text-gray-400">
                  {item.shippedAt && (
                    <span>Shipped {new Date(item.shippedAt).toLocaleDateString('en-IN')}</span>
                  )}
                  {item.deliveredAt && (
                    <span>Delivered {new Date(item.deliveredAt).toLocaleDateString('en-IN')}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

export default function TrackPage() {
  return (
    <Suspense>
      <TrackPageInner />
    </Suspense>
  );
}
