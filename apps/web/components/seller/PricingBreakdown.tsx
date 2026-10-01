'use client';

import { useEffect, useMemo, useState } from 'react';
import { computeListingEconomics, type SellerEconomicsRates } from '@clowe/shared';
import { api } from '@/lib/api';

let ratesCache: Promise<SellerEconomicsRates> | null = null;
function loadRates(): Promise<SellerEconomicsRates> {
  ratesCache ??= api<SellerEconomicsRates>('/api/seller/pricing-rates', { auth: true }).catch((err) => {
    ratesCache = null;
    throw err;
  });
  return ratesCache;
}

function money(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * What a price pays the seller, live. Runs the same shared calculator the
 * ledger posts from, with the rates fetched once, so what the form promises
 * is exactly what delivery will post. `listingPricePaise` follows the
 * cheapest variant; the seller can also type any price to try it.
 */
export function PricingBreakdown({ listingPricePaise }: { listingPricePaise: number | null }) {
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
    () => (rates ? computeListingEconomics({ sellerPricePaise: pricePaise, rates }) : null),
    [rates, pricePaise],
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
        <dl className="mt-2 space-y-1">
          <div className="flex justify-between font-semibold text-ink-900">
            <dt>Buyer pays</dt>
            <dd>{money(economics.buyerPaysPaise)}</dd>
          </div>
          <div className="flex justify-between text-gray-500">
            <dt className="pl-3">includes GST ({rates!.gstPercent}%), which you remit</dt>
            <dd>{money(economics.gstPaise)}</dd>
          </div>
          {economics.lines
            .filter((l) => l.key !== 'sale')
            .map((l) => (
              <div key={l.key} className="flex justify-between text-gray-600">
                <dt>{l.label}</dt>
                <dd className="text-red-600">− {money(-l.amountPaise)}</dd>
              </div>
            ))}
          <div className="flex justify-between border-t border-gray-200 pt-1.5 text-sm font-bold text-ink-900">
            <dt>You receive</dt>
            <dd>{money(economics.sellerReceivesPaise)}</dd>
          </div>
          <div className="flex justify-between text-gray-500">
            <dt>After the GST you remit</dt>
            <dd className="font-semibold">{money(economics.sellerKeepsAfterGstPaise)}</dd>
          </div>
        </dl>
      )}

      <p className="mt-2 text-[11px] text-gray-400">
        Per unit, at today&rsquo;s rates. Posted to your ledger on delivery with exactly this
        arithmetic. Shipping is charged to the buyer per order and is not part of this.
      </p>
    </div>
  );
}
