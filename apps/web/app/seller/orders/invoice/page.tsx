'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { SellerInvoice } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

function money(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function InvoiceView() {
  const params = useSearchParams();
  const orderId = params.get('orderId') ?? '';
  const [invoice, setInvoice] = useState<SellerInvoice | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!orderId) {
      setError('No order selected.');
      return;
    }
    api<SellerInvoice>(`/api/seller/orders/${orderId}/invoice`, { auth: true })
      .then(setInvoice)
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load the invoice'),
      );
  }, [orderId]);

  return (
    <div className="mx-auto max-w-3xl">
      <div data-print-hide className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-xl font-bold text-ink-900">Tax invoice</h1>
          <p className="text-xs text-gray-500">
            Covers only your lines of this order — other sellers invoice their own.
          </p>
        </div>
        <button
          onClick={() => window.print()}
          disabled={!invoice}
          className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          🖨 Print / Save as PDF
        </button>
      </div>

      {error && (
        <p data-print-hide className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {!invoice && !error && <p className="text-sm text-gray-500">Loading…</p>}

      {invoice && (
        <article className="print-sheet rounded-xl border border-gray-300 bg-white p-6">
          <header className="flex items-start justify-between border-b border-gray-200 pb-4">
            <div>
              <p className="font-display text-2xl font-bold uppercase tracking-[0.2em] text-ink-900">
                Clowe
              </p>
              <p className="mt-1 text-sm font-semibold text-ink-900">{invoice.seller.shopName}</p>
              <p className="text-xs leading-relaxed text-gray-600">
                {invoice.seller.line1 ?? '—'}
                <br />
                {[invoice.seller.city, invoice.seller.state, invoice.seller.pincode]
                  .filter(Boolean)
                  .join(', ')}
                {invoice.seller.gstNumber && (
                  <>
                    <br />
                    GSTIN: {invoice.seller.gstNumber}
                  </>
                )}
                {invoice.seller.panNumber && (
                  <>
                    <br />
                    PAN: {invoice.seller.panNumber}
                  </>
                )}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Tax invoice</p>
              <p className="font-mono text-sm font-bold text-ink-900">{invoice.invoiceNumber}</p>
              <p className="mt-1 text-xs text-gray-600">
                Issued {new Date(invoice.issuedAt).toLocaleDateString('en-IN')}
                <br />
                Order {invoice.orderNumber}
                <br />
                Placed {new Date(invoice.placedAt).toLocaleDateString('en-IN')}
              </p>
            </div>
          </header>

          <section className="grid grid-cols-2 gap-6 py-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Bill to</p>
              <p className="mt-1 text-sm font-semibold text-ink-900">{invoice.billTo.name}</p>
              <p className="text-xs leading-relaxed text-gray-600">
                {invoice.billTo.line1}
                {invoice.billTo.line2 && <>, {invoice.billTo.line2}</>}
                <br />
                {invoice.billTo.city}, {invoice.billTo.state} — {invoice.billTo.pincode}
                <br />
                Phone: {invoice.billTo.phone}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Payment</p>
              <p className="mt-1 text-xs text-gray-600">
                Method: <span className="font-semibold text-ink-900">{invoice.paymentMethod}</span>
                <br />
                Status: <span className="font-semibold text-ink-900">{invoice.paymentStatus}</span>
                <br />
                Place of supply: {invoice.billTo.state}
              </p>
            </div>
          </section>

          <table className="w-full text-xs">
            <thead>
              <tr className="border-y border-gray-200 text-left uppercase tracking-wide text-gray-500">
                <th className="py-2 font-semibold">Item</th>
                <th className="py-2 text-right font-semibold">Qty</th>
                <th className="py-2 text-right font-semibold">Rate</th>
                <th className="py-2 text-right font-semibold">Taxable</th>
                <th className="py-2 text-right font-semibold">GST</th>
                <th className="py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="py-2">
                    {line.title}
                    <span className="block text-[11px] text-gray-500">
                      {line.color} / {line.size}
                    </span>
                  </td>
                  <td className="py-2 text-right">{line.quantity}</td>
                  <td className="py-2 text-right">{money(line.unitPricePaise)}</td>
                  <td className="py-2 text-right">{money(line.taxablePaise)}</td>
                  <td className="py-2 text-right">{money(line.gstPaise)}</td>
                  <td className="py-2 text-right font-semibold">{money(line.grossPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="mt-4 flex justify-end">
            <dl className="w-64 space-y-1 text-xs">
              <div className="flex justify-between">
                <dt className="text-gray-500">Taxable value</dt>
                <dd>{money(invoice.taxablePaise)}</dd>
              </div>
              {invoice.isIntraState ? (
                <>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">CGST</dt>
                    <dd>{money(Math.round(invoice.gstPaise / 2))}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">SGST</dt>
                    <dd>{money(invoice.gstPaise - Math.round(invoice.gstPaise / 2))}</dd>
                  </div>
                </>
              ) : (
                <div className="flex justify-between">
                  <dt className="text-gray-500">IGST</dt>
                  <dd>{money(invoice.gstPaise)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-gray-200 pt-1.5 text-sm font-bold text-ink-900">
                <dt>Invoice total</dt>
                <dd>{formatPaise(invoice.totalPaise)}</dd>
              </div>
            </dl>
          </section>

          <footer className="mt-6 border-t border-gray-200 pt-3 text-[11px] leading-relaxed text-gray-500">
            <p>
              Prices are inclusive of GST. Apparel slab applied per line: 5% up to ₹1,000, 12%
              above. Verify against your own tax advice before filing.
            </p>
            <p className="mt-1">
              This is a computer-generated invoice for the items sold by{' '}
              {invoice.seller.shopName} on Clowe and does not require a signature.
            </p>
          </footer>
        </article>
      )}
    </div>
  );
}

/** useSearchParams needs a boundary for the client-side bailout. */
export default function SellerInvoicePage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
      <InvoiceView />
    </Suspense>
  );
}
