'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  breakdownRows,
  computeListingEconomics,
  type BreakdownRowKind,
  type CategoryRules,
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
  if (kind === 'deduction' || kind === 'tax') return `− ${money(-paise)}`;
  return money(paise);
}

/** Classes for both cells of a row, so a rule or a gap spans the whole line. */
const ROW: Record<BreakdownRowKind, { cell: string; label: string; amount: string }> = {
  start: { cell: 'py-1', label: 'font-semibold text-ink-900', amount: 'font-semibold text-ink-900' },
  deduction: { cell: 'py-0.5', label: 'text-gray-600', amount: 'text-red-600' },
  subtotal: {
    cell: 'mt-1 border-t border-gray-300 pt-1.5 pb-1',
    label: 'font-semibold text-ink-900',
    amount: 'font-semibold text-ink-900',
  },
  // GST is the seller's own tax, not something Clowe takes: set apart by a
  // gap and a dashed rule, in neutral grey rather than deduction red.
  tax: { cell: 'mt-2 border-t border-dashed border-gray-300 pt-2 pb-1', label: 'text-gray-500', amount: 'text-gray-500' },
  total: {
    cell: 'border-t border-gray-300 pt-1.5',
    label: 'text-sm font-bold text-ink-900',
    amount: 'text-sm font-bold text-ink-900',
  },
};

/**
 * What a price pays the seller, live. Runs the same shared calculator the
 * ledger posts from, with the rates fetched once, so what the form promises
 * is exactly what delivery will post. `listingPricePaise` follows the
 * cheapest variant; the seller can also type any price to try it.
 */
export function PricingBreakdown({
  listingPricePaise,
  taxRules,
}: {
  listingPricePaise: number | null;
  /** The chosen category's GST rule; null until a category is picked. */
  taxRules: Pick<CategoryRules, 'taxRule' | 'defaultTaxRatePercent'> | null;
}) {
  const [rates, setRates] = useState<SellerEconomicsRates | null>(null);
  const [typed, setTyped] = useState<string | null>(null);

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

  return (
    <div className="mt-4 rounded-xl border border-gray-100 bg-cream-50 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-ink-900">What this price pays you</p>
        <label className="flex items-center gap-1.5 text-gray-500">
          Try a price ₹
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
                <dt className={`${style.cell} ${style.label} break-words`}>
                  {row.label}
                  {row.kind === 'tax' && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-gray-400">
                      Collected from the buyer inside the price. You pay it in your GST return; Clowe keeps none of it.
                    </span>
                  )}
                </dt>
                <dd className={`${style.cell} ${style.amount} whitespace-nowrap pl-4 text-right`}>
                  {signed(row.amountPaise, row.kind)}
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      {economics?.gstSlabBand && (
        // The value-slab band where neither GST rate is self-consistent: say
        // what the seller can do about it, in their own numbers.
        <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
          Priced between {money(economics.gstSlabBand.fromPaise)} and {money(economics.gstSlabBand.toPaise)}, this
          item is taxed at {economics.gstRatePercent}%. At {money(economics.gstSlabBand.meritUpToPaise)} or less it
          would be {rates!.gst.meritPercent}%.
        </p>
      )}

      <p className="mt-2 text-[11px] text-gray-400">
        Per unit, at today&rsquo;s rates. Posted to your ledger on delivery with exactly this
        arithmetic. Shipping is charged to the buyer per order and is not part of this.
      </p>
    </div>
  );
}
