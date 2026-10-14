'use client';

import { useEffect, useState } from 'react';
import type { SellerBookingQuote, SellerOrderBulkResult } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/**
 * Booking with Delhivery, confirmed: before anything is booked the seller sees
 * each parcel's weight and Delhivery's estimate of what it will cost them,
 * and books only on "Confirm". The final charge comes on delivery, at the
 * weight Delhivery measures.
 */
export function BookingConfirm({
  itemIds,
  onBooked,
  onClose,
}: {
  itemIds: string[];
  onBooked: (result: SellerOrderBulkResult) => void;
  onClose: () => void;
}) {
  const [quote, setQuote] = useState<SellerBookingQuote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SellerBookingQuote>(`/api/seller/orders/booking-quote?ids=${encodeURIComponent(itemIds.join(','))}`, { auth: true })
      .then(setQuote)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not get the estimate'));
  }, [itemIds]);

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const result = await api<SellerOrderBulkResult>('/api/seller/orders/bulk', {
        method: 'POST',
        body: { itemIds: quote!.parcels.flatMap((p) => p.itemIds), action: 'assign' },
        auth: true,
      });
      onBooked(result);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Booking failed');
    } finally {
      setBusy(false);
    }
  }

  const bookable = quote?.parcels.length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-base font-bold text-ink-900">Book with Delhivery</h2>
        <p className="mt-1 text-xs text-gray-500">
          Delivery is free for the buyer; you pay Delhivery&apos;s freight. Here is its estimate — the final charge is
          posted when the parcel is delivered, at the weight Delhivery measures (billed per 0.5 kg, on the greater of
          actual and volumetric weight).
        </p>

        {!quote && !error && <div className="mt-4 h-20 animate-pulse rounded-xl bg-gray-100" />}

        {quote && (
          <>
            <ul className="mt-4 divide-y divide-gray-100 rounded-xl border border-gray-100 text-xs">
              {quote.parcels.map((p) => (
                <li key={p.orderId} className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink-900">
                      {p.orderNumber} · {p.itemIds.length} item{p.itemIds.length === 1 ? '' : 's'} in one parcel
                    </p>
                    <p className="text-gray-500">
                      {p.chargeableGrams / 1000} kg charged · Surface · {p.payment === 'COD' ? `COD ${formatPaise(p.codAmountPaise)}` : 'Prepaid'}
                    </p>
                    {p.payment === 'COD' && p.codFeePaise !== null && p.forwardFreightPaise !== null && (
                      <p className="text-gray-500">
                        Freight {formatPaise(p.forwardFreightPaise)} + COD fee {formatPaise(p.codFeePaise)}
                      </p>
                    )}
                    {p.error && <p className="mt-0.5 text-amber-700">{p.error}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-bold text-ink-900">{p.totalPaise === null ? '—' : formatPaise(p.totalPaise)}</p>
                    <p className="text-[10px] text-gray-400">incl. GST</p>
                  </div>
                </li>
              ))}
            </ul>
            {quote.skipped.length > 0 && (
              <p className="mt-2 text-[11px] text-gray-500">
                Not booked: {quote.skipped.length} item(s) — {[...new Set(quote.skipped.map((s) => s.reason))].join('; ')}
              </p>
            )}
            {bookable > 0 && (
              <p className="mt-3 flex justify-between text-sm">
                <span className="text-gray-600">Estimated total</span>
                <span className="font-bold text-ink-900">{formatPaise(quote.totalPaise)}</span>
              </p>
            )}
            {quote.provider === 'mock' && (
              <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                Test courier: this estimate is the flat test rate, not Delhivery&apos;s.
              </p>
            )}
          </>
        )}

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || bookable === 0}
            onClick={() => void confirm()}
            className="rounded-lg bg-ink-900 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
          >
            {busy ? 'Booking…' : `Confirm booking${bookable > 1 ? ` (${bookable} parcels)` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
