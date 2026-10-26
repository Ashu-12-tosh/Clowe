'use client';

import { useEffect, useState } from 'react';
import type { SellerOrderCharges } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '';
}

function kg(grams: number | null): string {
  return grams ? `${(grams / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg` : '—';
}

/**
 * What this order costs the seller: Delhivery's charges (estimated when the
 * order was placed, at booking, and as charged — RTO and return pickups with
 * their date and reason) and Clowe's fees with the GST on them, adding up to
 * what they are paid for the goods.
 */
export default function OrderCharges({ orderId, refreshKey }: { orderId: string; refreshKey?: unknown }) {
  const [charges, setCharges] = useState<SellerOrderCharges | null>(null);

  useEffect(() => {
    api<SellerOrderCharges>(`/api/seller/orders/${orderId}/charges`, { auth: true })
      .then(setCharges)
      .catch(() => setCharges(null));
  }, [orderId, refreshKey]);

  if (!charges) return null;
  const f = charges.fees;
  const row = (label: string, paise: number, key: string, sub?: string) => (
    <div className="flex justify-between gap-3" data-fee={key}>
      <dt className="text-gray-500">
        {label}
        {sub && <span className="block text-[11px] text-gray-400">{sub}</span>}
      </dt>
      <dd className="whitespace-nowrap font-semibold text-ink-900">{key === 'gross' || key === 'receives' ? formatPaise(paise) : `− ${formatPaise(paise)}`}</dd>
    </div>
  );
  const forward = charges.parcels.filter((p) => p.kind === 'FORWARD');

  return (
    <>
      <section className="rounded-2xl border border-gray-100 bg-white p-4 text-xs" data-order-delivery-charges>
        <h2 className="text-sm font-bold text-ink-900">Delivery charges (Delhivery, GST included)</h2>
        <dl className="mt-2 space-y-1.5">
          <div className="flex justify-between gap-3" data-charge="placement">
            <dt className="text-gray-500">
              Estimate when the order was placed
              {charges.placement && (
                <span className="block text-[11px] text-gray-400">
                  To {charges.placement.destinationPincode}
                  {charges.placement.zone ? `, zone ${charges.placement.zone}` : ''} · {kg(charges.placement.chargeableGrams)}
                </span>
              )}
            </dt>
            <dd className="font-semibold text-ink-900">
              {charges.placement?.freightEstimatePaise != null ? formatPaise(charges.placement.freightEstimatePaise) : '—'}
            </dd>
          </div>
          {forward.map((p) => (
            <div key={p.shipmentId} className="contents">
              <div className="flex justify-between gap-3" data-charge="booking">
                <dt className="text-gray-500">
                  Estimate at booking
                  <span className="block text-[11px] text-gray-400">AWB {p.awbNumber ?? '—'} · {day(p.bookedAt)}</span>
                </dt>
                <dd className="font-semibold text-ink-900">{p.bookingEstimatePaise != null ? formatPaise(p.bookingEstimatePaise) : '—'}</dd>
              </div>
              <div className="flex justify-between gap-3" data-charge="actual">
                <dt className="text-gray-500">
                  Actual charge
                  <span className="block text-[11px] text-gray-400">
                    {p.chargedPaise != null ? `at ${kg(p.chargedWeightGrams)} charged` : 'posted when the parcel is delivered'}
                  </span>
                </dt>
                <dd className="font-semibold text-ink-900">{p.chargedPaise != null ? formatPaise(p.chargedPaise) : '—'}</dd>
              </div>
            </div>
          ))}
        </dl>
        {charges.lines.length > 0 && (
          <ul className="mt-3 space-y-1.5 border-t border-gray-100 pt-2" data-charge-lines>
            {charges.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-3" data-charge-line={l.kind}>
                <span className="text-gray-600">
                  {l.label}
                  <span className="block text-[11px] text-gray-400">
                    {day(l.eventAt ?? l.at)}
                    {l.awbNumber ? ` · AWB ${l.awbNumber}` : ''}
                    {l.reason ? ` · ${l.reason}` : ''}
                  </span>
                </span>
                <span className={`whitespace-nowrap font-semibold ${l.amountPaise < 0 ? 'text-green-700' : 'text-red-600'}`}>
                  {l.amountPaise < 0 ? `+ ${formatPaise(-l.amountPaise)}` : `− ${formatPaise(l.amountPaise)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-gray-400">
          Buyers never pay for delivery.{' '}
          <a href="/pages/delivery-charges" target="_blank" rel="noreferrer" className="font-semibold text-brand-600 hover:underline" data-help-link>
            Delivery charges explained
          </a>
        </p>
      </section>

      <section className="rounded-2xl border border-gray-100 bg-white p-4 text-xs" data-order-fees>
        <h2 className="text-sm font-bold text-ink-900">Clowe fees on your items</h2>
        <dl className="mt-2 space-y-1.5">
          {row('Sale (what the buyer paid, GST included)', f.grossPaise, 'gross')}
          {row('Referral fee', f.referralPaise, 'referral')}
          {row('Payment collection fee', f.collectionPaise, 'collection')}
          {row('GT charge', f.gtPaise, 'gt')}
          {row('Handling fee', f.handlingPaise, 'handling')}
          {f.otherFeesPaise > 0 && row('Older fees (platform, closing)', f.otherFeesPaise, 'other')}
          {row(
            `GST @${f.gstPercent}% on Clowe fees`,
            f.cloweFeeGstPaise,
            'clowe-gst',
            f.intraState ? `CGST ${formatPaise(f.cgstPaise)} + SGST ${formatPaise(f.sgstPaise)}` : `IGST ${formatPaise(f.igstPaise)}`,
          )}
          {row('TDS (s.194-O)', f.tdsPaise, 'tds')}
          {row('GST TCS (s.52)', f.tcsPaise, 'tcs')}
          <div className="border-t border-gray-100 pt-1.5">{row('Paid to you for the goods', f.receivesPaise, 'receives')}</div>
        </dl>
        <p className="mt-2 text-[11px] text-gray-400">Before Delhivery&apos;s charges above. The GST on Clowe&apos;s fees is on Clowe&apos;s monthly tax invoice to you.</p>
      </section>
    </>
  );
}
