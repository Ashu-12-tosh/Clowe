'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { CreditNote, SellerInvoice } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import TaxInvoiceDocument from '@/components/TaxInvoiceDocument';
import CreditNoteDocument from '@/components/CreditNoteDocument';

function money(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function InvoiceView() {
  const params = useSearchParams();
  const orderId = params.get('orderId') ?? '';
  const [invoice, setInvoice] = useState<SellerInvoice | null>(null);
  // Credit notes reducing this invoice (returned, refunded lines).
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
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
    api<CreditNote[]>(`/api/seller/orders/${orderId}/credit-notes`, { auth: true })
      .then(setCreditNotes)
      .catch(() => setCreditNotes([]));
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
        <TaxInvoiceDocument
          invoice={invoice}
          payment={
            <>
              Method: <span className="font-semibold text-ink-900">{invoice.paymentMethod}</span>
              <br />
              Status: <span className="font-semibold text-ink-900">{invoice.paymentStatus}</span>
            </>
          }
          qr={
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={invoice.qr.dataUrl}
                alt="QR code - open this order in the seller panel"
                className="ml-auto mt-2 h-20 w-20"
              />
              <p className="text-[9px] font-semibold uppercase tracking-wide text-gray-400">Scan for order details</p>
            </>
          }
        />
      )}
      {invoice &&
        creditNotes.map((note) => (
          <div key={note.creditNoteNumber} className="mt-4">
            <CreditNoteDocument note={note} />
          </div>
        ))}
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
