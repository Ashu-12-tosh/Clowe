'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  breakdownRows,
  computeListingEconomics,
  type BreakdownRowKind,
  type CategoryRules,
  type SellerDeliveryEstimate,
  type SellerEconomicsRates,
} from '@clowe/shared';
import { api } from '@/lib/api';

let ratesCache: Promise<SellerEconomicsRates> | null = null;
/** The calculator's rates, GST settings included — fetched once per page. */
export function loadRates(): Promise<SellerEconomicsRates> {
  ratesCache ??= api<SellerEconomicsRates>('/api/seller/pricing-rates', { auth: true }).catch((err) => {
    ratesCache = null;
    throw err;
  });
  return ratesCache;
}

function money(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A row's amount with its sign: what it takes away, or the total it is. */
function signed(paise: number, kind: BreakdownRowKind): string {
  if (kind === 'deduction') return `− ${money(-paise)}`;
  return paise < 0 ? `− ${money(-paise)}` : money(paise);
}

/** Classes for both cells of a row, so a rule or a gap spans the whole line. */
const ROW: Record<BreakdownRowKind, { cell: string; label: string; amount: string }> = {
  start: { cell: 'py-1', label: 'font-semibold text-ink-900', amount: 'font-semibold text-ink-900' },
  deduction: { cell: 'py-0.5', label: 'text-gray-600', amount: 'text-red-600' },
  total: {
    cell: 'border-t border-gray-300 pt-1.5',
    label: 'text-sm font-bold text-ink-900',
    amount: 'text-sm font-bold text-ink-900',
  },
};

/**
 * What a price pays the seller, live. Runs the same shared calculator the
 * ledger posts from, with the rates fetched once, so what the form promises
 * is exactly what delivery will post. Prices here are the seller's, before
 * GST: `listingPricePaise` follows the cheapest variant, and the seller can
 * also type any price to try it.
 */
export function PricingBreakdown({
  listingPricePaise,
  taxRules,
  categoryId,
  parcel,
}: {
  listingPricePaise: number | null;
  /** The chosen category's GST rule; null until a category is picked. */
  taxRules: Pick<CategoryRules, 'taxRule' | 'defaultTaxRatePercent'> | null;
  categoryId?: string | null;
  /** The product's parcel: what delivery is estimated on. */
  parcel?: { weightGrams: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null };
}) {
  const [rates, setRates] = useState<SellerEconomicsRates | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<SellerDeliveryEstimate | null>(null);

  useEffect(() => {
    loadRates().then(setRates).catch(() => {});
  }, []);

  // The typed price wins while the seller is exploring; the listing price
  // takes over again whenever it changes.
  useEffect(() => {
    setTyped(null);
  }, [listingPricePaise]);

  const pricePaise =
    typed !== null ? Math.max(0, Math.round(Number(typed || '0') * 100)) : (listingPricePaise ?? 0);

  const economics = useMemo(
    () => (rates ? computeListingEconomics({ sellerPricePaise: pricePaise, rates, taxRules }) : null),
    [rates, pricePaise, taxRules],
  );

  // Delivery for this parcel, once the seller stops typing. Answers are cached
  // per weight slab and route on the server, so this rarely reaches Delhivery.
  const weightGrams = parcel?.weightGrams ?? null;
  const { lengthMm = null, widthMm = null, heightMm = null } = parcel ?? {};
  useEffect(() => {
    if (!weightGrams) {
      setDelivery(null);
      return;
    }
    const query = new URLSearchParams({ weightGrams: String(weightGrams), pricePaise: String(pricePaise) });
    if (lengthMm && widthMm && heightMm) {
      query.set('lengthMm', String(lengthMm));
      query.set('widthMm', String(widthMm));
      query.set('heightMm', String(heightMm));
    }
    if (categoryId) query.set('categoryId', categoryId);
    const timer = setTimeout(() => {
      api<SellerDeliveryEstimate>(`/api/seller/pricing-rates/delivery-estimate?${query}`, { auth: true })
        .then(setDelivery)
        .catch(() => setDelivery(null));
    }, 500);
    return () => clearTimeout(timer);
  }, [weightGrams, lengthMm, widthMm, heightMm, pricePaise, categoryId]);

  return (
    <div className="mt-4 rounded-xl border border-gray-100 bg-cream-50 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-ink-900">What this price pays you</p>
        <label className="flex items-center gap-1.5 text-gray-500">
          Try a price before GST ₹
          <input
            type="number"
            min={0}
            value={typed ?? (listingPricePaise !== null ? String(listingPricePaise / 100) : '')}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="0"
            className="w-24 rounded-lg border border-gray-300 bg-white px-2 py-1 text-right text-xs outline-none focus:border-brand-600"
            aria-label="Try a price in rupees"
          />
        </label>
      </div>

      {!rates && <p className="mt-2 text-gray-400">Loading rates…</p>}

      {economics && (
        // One column of figures: every label on the left, every signed amount
        // right-aligned beside it, in the order the money moves.
        <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] tabular-nums" data-breakdown>
          {breakdownRows(economics).map((row) => {
            const style = ROW[row.kind];
            return (
              <div key={row.key} className="contents" data-row={row.key}>
                <dt className={`${style.cell} ${style.label} break-words`}>{row.label}</dt>
                <dd
                  className={`${style.cell} ${row.kind === 'total' && row.amountPaise < 0 ? 'text-sm font-bold text-red-600' : style.amount} whitespace-nowrap pl-4 text-right`}
                >
                  {signed(row.amountPaise, row.kind)}
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      {economics && (
        // What actually reaches the bank: the earning plus the GST collected
        // from the buyer, which the seller files. It is what the ledger posts.
        <p className="mt-1 text-right text-[11px] text-gray-500" data-bank>
          Paid to your bank: {signed(economics.sellerReceivesPaise, 'total')} (includes the GST you file)
        </p>
      )}

      {economics && pricePaise > 0 && economics.sellerKeepsAfterGstPaise <= 0 && (
        <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-2 text-[11px] font-semibold text-red-700" data-loss>
          {economics.sellerKeepsAfterGstPaise < 0
            ? `At this price you lose ${money(-economics.sellerKeepsAfterGstPaise)} per unit`
            : 'At this price you make nothing per unit'}
        </p>
      )}

      <div className="mt-3 border-t border-gray-200 pt-2" data-delivery>
        <p className="font-semibold text-ink-900">Delivery — you pay Delhivery, buyers pay nothing</p>
        {!weightGrams && <p className="mt-1 text-gray-400">Enter the weight below to see what a parcel costs.</p>}
        {weightGrams && !delivery && <p className="mt-1 text-gray-400">Getting Delhivery&rsquo;s estimate…</p>}
        {delivery?.error && <p className="mt-1 text-amber-700">{delivery.error}</p>}
        {delivery && delivery.cases.length > 0 && (
          <dl className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 tabular-nums">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              From {delivery.originPincode}, {delivery.slabGrams / 1000} kg
            </dt>
            <dd className="text-right text-[10px] font-semibold uppercase tracking-wide text-gray-400">Freight</dd>
            <dd className="text-right text-[10px] font-semibold uppercase tracking-wide text-gray-400">You keep</dd>
            {delivery.cases.map((c) => (
              <div key={c.key} className="contents" data-case={c.key}>
                <dt className="py-0.5 text-gray-600">
                  {c.label} <span className="text-gray-400">({c.destinationPincode})</span>
                </dt>
                <dd className="py-0.5 text-right text-red-600">− {money(c.freightPaise)}</dd>
                <dd className="py-0.5 text-right font-semibold text-ink-900">
                  {economics ? signed(economics.sellerKeepsAfterGstPaise - c.freightPaise, 'total') : '—'}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {delivery?.codFeePaise != null && delivery.codFeePaise > 0 && (
          <p className="mt-1 text-gray-600" data-cod>
            COD orders: <span className="font-semibold text-red-600">+{money(delivery.codFeePaise)}</span> Delhivery COD fee
          </p>
        )}
        <p className="mt-1.5 text-[11px] text-gray-500">
          Delhivery bills every 0.5 kg, on the greater of actual and volumetric weight (L × W × H in cm ÷ 5000).
          {delivery && ` This product is charged as ${delivery.slabGrams / 1000} kg.`} One estimate per parcel; the final
          charge is posted when it is delivered.
          {delivery?.provider === 'mock' && ' Test courier: these are flat test rates, not Delhivery’s.'}
        </p>
      </div>

      <p className="mt-2 text-[11px] text-gray-400">
        Per unit, at today&rsquo;s rates. Posted to your ledger on delivery with exactly this
        arithmetic. Delivery is free for buyers; the freight above comes off per parcel.
      </p>
    </div>
  );
}
