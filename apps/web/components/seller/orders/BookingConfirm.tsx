'use client';

import { useEffect, useRef, useState } from 'react';
import type { ParcelBox, SellerBookingQuote, SellerOrderBulkResult } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/** A box as typed: kilograms and centimetres, as the seller measures it. */
interface BoxForm {
  kg: string;
  l: string;
  w: string;
  h: string;
}

const toForm = (p: SellerBookingQuote['parcels'][number]): BoxForm => ({
  kg: String(p.weightGrams / 1000),
  l: p.lengthMm ? String(p.lengthMm / 10) : '',
  w: p.widthMm ? String(p.widthMm / 10) : '',
  h: p.heightMm ? String(p.heightMm / 10) : '',
});

/** The box in the API's units, or null while it isn't a complete, sensible box. */
function toBox(f: BoxForm): ParcelBox | null {
  const kg = Number(f.kg);
  const [l, w, h] = [f.l, f.w, f.h].map(Number);
  if (!(kg > 0) || !(l! > 0) || !(w! > 0) || !(h! > 0)) return null;
  return { weightGrams: Math.round(kg * 1000), lengthMm: Math.round(l! * 10), widthMm: Math.round(w! * 10), heightMm: Math.round(h! * 10) };
}

/**
 * Booking with Delhivery, confirmed: before anything is booked the seller
 * confirms each parcel's weight and box size (prefilled from the products)
 * and sees Delhivery's estimate for it, re-priced as they correct the box.
 * The booking carries their figures. The final charge comes on delivery, at
 * the weight Delhivery measures.
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
  const [boxes, setBoxes] = useState<Record<string, BoxForm>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pricing, setPricing] = useState(false);
  const first = useRef(true);

  const complete = (): Record<string, ParcelBox> | null => {
    const out: Record<string, ParcelBox> = {};
    for (const [orderId, f] of Object.entries(boxes)) {
      const box = toBox(f);
      if (!box) return null;
      out[orderId] = box;
    }
    return out;
  };

  // First look: the boxes the products suggest.
  useEffect(() => {
    api<SellerBookingQuote>('/api/seller/orders/booking-quote', { method: 'POST', body: { itemIds }, auth: true })
      .then((q) => {
        setQuote(q);
        setBoxes(Object.fromEntries(q.parcels.map((p) => [p.orderId, toForm(p)])));
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not get the estimate'));
  }, [itemIds]);

  // Re-price once the seller stops editing a box.
  useEffect(() => {
    if (first.current) {
      first.current = Object.keys(boxes).length === 0;
      return;
    }
    const typed = complete();
    if (!typed) return;
    setPricing(true);
    const timer = setTimeout(() => {
      api<SellerBookingQuote>('/api/seller/orders/booking-quote', { method: 'POST', body: { itemIds, boxes: typed }, auth: true })
        .then(setQuote)
        .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not get the estimate'))
        .finally(() => setPricing(false));
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-price on box edits only
  }, [boxes]);

  async function confirm() {
    const typed = complete();
    if (!typed) {
      setError('Give every parcel its weight and box size');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api<SellerOrderBulkResult>('/api/seller/orders/bulk', {
        method: 'POST',
        body: { itemIds: quote!.parcels.flatMap((p) => p.itemIds), action: 'assign', boxes: typed },
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
  const field = 'w-14 rounded border border-gray-300 px-1.5 py-1 text-right text-xs outline-none focus:border-brand-600';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-base font-bold text-ink-900">Book with Delhivery</h2>
        <p className="mt-1 text-xs text-gray-500">
          Check each parcel&apos;s weight and box size — Delhivery bills every 0.5 kg, on the greater of the weight and
          the box&apos;s volumetric weight (L × W × H in cm ÷ 5000). Delivery is free for the buyer; you pay the
          freight, posted when the parcel is delivered at the weight Delhivery measures.
        </p>

        {!quote && !error && <div className="mt-4 h-20 animate-pulse rounded-xl bg-gray-100" />}

        {quote && (
          <>
            <ul className="mt-4 divide-y divide-gray-100 rounded-xl border border-gray-100 text-xs">
              {quote.parcels.map((p) => {
                const f = boxes[p.orderId] ?? toForm(p);
                const set = (patch: Partial<BoxForm>) => setBoxes((b) => ({ ...b, [p.orderId]: { ...f, ...patch } }));
                return (
                  <li key={p.orderId} className="p-3" data-parcel={p.orderId}>
                    <div className="flex items-start justify-between gap-3">
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
                        <p className="text-[10px] text-gray-400">{pricing ? 'repricing…' : 'incl. GST'}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-gray-600">
                      <label className="flex items-center gap-1">
                        Weight
                        <input aria-label="Weight in kg" inputMode="decimal" value={f.kg} onChange={(e) => set({ kg: e.target.value })} className={field} />
                        kg
                      </label>
                      <span className="ml-2">Box</span>
                      <input aria-label="Length in cm" inputMode="decimal" value={f.l} onChange={(e) => set({ l: e.target.value })} className={field} placeholder="L" />
                      ×
                      <input aria-label="Width in cm" inputMode="decimal" value={f.w} onChange={(e) => set({ w: e.target.value })} className={field} placeholder="W" />
                      ×
                      <input aria-label="Height in cm" inputMode="decimal" value={f.h} onChange={(e) => set({ h: e.target.value })} className={field} placeholder="H" />
                      cm
                    </div>
                    {!toBox(f) && <p className="mt-1 text-[11px] text-amber-700">Give the weight and all three box sides.</p>}
                  </li>
                );
              })}
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
            disabled={busy || pricing || bookable === 0 || complete() === null}
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
