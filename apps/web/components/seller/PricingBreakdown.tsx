'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  bpsToPercent,
  breakdownRows,
  slabDescription,
  slabFor,
  computeListingEconomics,
  type BreakdownRow,
  type BreakdownRowKind,
  type CategoryRules,
  type SellerDeliveryEstimate,
  type PricingRatesView,
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
  const [feesOpen, setFeesOpen] = useState(false);

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

  const economics = useMemo(() => {
    if (!rates) return null;
    // The referral fee is the chosen category's: its fee-schedule slabs (the
    // rate follows the selling price), else its flat percent.
    const view = rates as SellerEconomicsRates & Partial<PricingRatesView>;
    const own = categoryId ? view.categoryReferralPercent?.[categoryId] : undefined;
    const slabs = categoryId ? view.categoryReferralSlabs?.[categoryId] : undefined;
    const withCategory = rates.v2
      ? { ...rates, v2: { ...rates.v2, referralPercent: own ?? rates.v2.referralPercent, referralSlabs: slabs?.slabs ?? null } }
      : rates;
    return computeListingEconomics({ sellerPricePaise: pricePaise, rates: withCategory, taxRules });
  }, [rates, pricePaise, taxRules, categoryId]);

  // Which schedule row and slab the fee came from, under the breakdown.
  const referralNote = useMemo(() => {
    if (!rates || !categoryId || !economics) return null;
    const found = (rates as SellerEconomicsRates & Partial<PricingRatesView>).categoryReferralSlabs?.[categoryId];
    if (!found) return null;
    // One unit: its selling price, GST included, picks the slab.
    const slab = slabFor(found.slabs, economics.grossPaise);
    return slab ? `Referral fee: ${found.sheetCategory}, ${slabDescription(slab)} — ${bpsToPercent(slab.rateBps)}% of the whole price.` : null;
  }, [rates, categoryId, economics]);

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
          {groupFees(breakdownRows(economics)).map((row) => {
            if (row.kind === 'fees') {
              return (
                <div key="fees" className="contents" data-row="clowe-fees">
                  <dt className={`${ROW.deduction.cell} ${ROW.deduction.label}`}>
                    <button
                      type="button"
                      onClick={() => setFeesOpen((v) => !v)}
                      aria-expanded={feesOpen}
                      className="font-semibold text-gray-700 hover:text-ink-900"
                      data-fees-toggle
                    >
                      {feesOpen ? '▾' : '▸'} Clowe fees
                    </button>
                  </dt>
                  <dd className={`${ROW.deduction.cell} ${ROW.deduction.amount} whitespace-nowrap pl-4 text-right`}>
                    {signed(row.amountPaise, 'deduction')}
                  </dd>
                  {feesOpen &&
                    row.parts.map((part) => (
                      <div key={part.key} className="contents" data-row={part.key}>
                        <dt className="break-words py-0.5 pl-4 text-[11px] text-gray-500">{part.label}</dt>
                        <dd className="whitespace-nowrap py-0.5 pl-4 text-right text-[11px] text-red-500">{signed(part.amountPaise, 'deduction')}</dd>
                      </div>
                    ))}
                </div>
              );
            }
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
      {referralNote && (
        <p className="mt-1 text-[11px] text-gray-500" data-referral-slab>
          {referralNote}{' '}
          <a href="/pages/referral-fee-schedule" target="_blank" rel="noreferrer" className="font-semibold text-brand-600 hover:underline">
            All rates
          </a>
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
        {delivery && <ChargeableWeight estimate={delivery} />}
        {delivery && delivery.cases.length > 0 && (
          <DeliveryCasesTable estimate={delivery} keepPaise={economics ? economics.sellerKeepsAfterGstPaise : null} />
        )}
        {delivery?.codFeePaise != null && delivery.codFeePaise > 0 && (
          <p className="mt-1 text-gray-600" data-cod>
            COD orders: <span className="font-semibold text-red-600">+{money(delivery.codFeePaise)}</span> Delhivery COD fee
          </p>
        )}
        <p className="mt-1.5 text-[11px] text-gray-500">
          All amounts include 18% GST. Forward is charged when the parcel is delivered; RTO only if it comes back
          undelivered (on top of the forward); return pickup only when you approve a customer return. The final charge is
          at the weight Delhivery measures.
          {delivery?.provider === 'mock' && ' Test courier: these are flat test rates, not Delhivery’s.'}{' '}
          <a href="/pages/delivery-charges" target="_blank" rel="noreferrer" className="font-semibold text-brand-600 hover:underline" data-help-link>
            Delivery charges explained
          </a>
          {' · '}
          <a href="/seller/shipping-calculator" target="_blank" rel="noreferrer" className="font-semibold text-brand-600 hover:underline">
            Shipping charges calculator
          </a>
        </p>
      </div>

      <p className="mt-2 text-[11px] text-gray-400">
        Per unit, at today&rsquo;s rates. Posted to your ledger on delivery with exactly this
        arithmetic. Delivery is free for buyers; the freight above comes off per parcel.
      </p>
    </div>
  );
}

const FEE_KEYS = new Set(['commission', 'gt', 'gateway', 'handling', 'platform', 'closing']);

type GroupedRow = BreakdownRow | { kind: 'fees'; key: 'fees'; amountPaise: number; parts: BreakdownRow[] };

/** Clowe's own fees folded into one "Clowe fees" row (opened on a tap); their GST stays its own line. */
function groupFees(rows: BreakdownRow[]): GroupedRow[] {
  const parts = rows.filter((r) => FEE_KEYS.has(r.key) && r.amountPaise !== 0);
  if (parts.length === 0) return rows.filter((r) => !FEE_KEYS.has(r.key));
  const out: GroupedRow[] = [];
  for (const r of rows) {
    if (FEE_KEYS.has(r.key)) {
      if (r === parts[0]) out.push({ kind: 'fees', key: 'fees', amountPaise: parts.reduce((sum, p) => sum + p.amountPaise, 0), parts });
      continue;
    }
    out.push(r);
  }
  return out;
}

function kg(grams: number): string {
  return `${(grams / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg`;
}

/** "Actual 0.8 kg · volumetric 1.2 kg → charged as 1.5 kg". */
export function ChargeableWeight({ estimate }: { estimate: SellerDeliveryEstimate }) {
  return (
    <p className="mt-1 text-[11px] text-gray-600" data-chargeable>
      Actual {kg(estimate.actualGrams)}
      {' · '}
      {estimate.volumetricGrams !== null ? <>volumetric {kg(estimate.volumetricGrams)} (L × W × H in cm ÷ 5000)</> : 'volumetric: add the box size'}
      {' → '}
      <span className="font-semibold text-ink-900">charged as {kg(estimate.slabGrams)}</span>
      <span className="text-gray-400"> (the greater, in 0.5 kg steps)</span>
    </p>
  );
}

/** Forward, RTO and return pickup for each sample place, GST included. */
export function DeliveryCasesTable({ estimate, keepPaise }: { estimate: SellerDeliveryEstimate; keepPaise: number | null }) {
  const head = 'text-right text-[10px] font-semibold uppercase tracking-wide text-gray-400';
  const opt = (p: number | null) => (p === null ? '—' : `− ${money(p)}`);
  return (
    <div className="mt-1.5 overflow-x-auto">
      <table className="w-full min-w-[26rem] tabular-nums" data-delivery-cases>
        <thead>
          <tr>
            <th className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">From {estimate.originPincode}</th>
            <th className={head}>Zone</th>
            <th className={head}>Forward</th>
            <th className={head} title="Only if it comes back undelivered, on top of the forward">RTO</th>
            <th className={head} title="Only for a customer return you approve">Return pickup</th>
            {keepPaise !== null && <th className={head}>You keep</th>}
          </tr>
        </thead>
        <tbody>
          {estimate.cases.map((c) => (
            <tr key={c.key} data-case={c.key}>
              <td className="py-0.5 text-gray-600">
                {c.label} <span className="text-gray-400">({c.destinationPincode})</span>
              </td>
              <td className="py-0.5 text-right text-gray-500">{c.zone || '—'}</td>
              <td className="py-0.5 text-right text-red-600">− {money(c.freightPaise)}</td>
              <td className="py-0.5 text-right text-red-500" data-rto>{opt(c.rtoPaise)}</td>
              <td className="py-0.5 text-right text-red-500" data-return>{opt(c.returnPaise)}</td>
              {keepPaise !== null && (
                <td className="py-0.5 text-right font-semibold text-ink-900">{signed(keepPaise - c.freightPaise, 'total')}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
