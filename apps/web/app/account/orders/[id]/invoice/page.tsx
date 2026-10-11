'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import type { OrderDetailView, PaymentMethod, TaxInvoice } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import TaxInvoiceDocument from '@/components/TaxInvoiceDocument';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  UPI: 'UPI',
  CARD: 'card',
  NETBANKING: 'net banking',
  WALLET: 'wallet',
  EMI: 'EMI',
  COD: 'Cash on Delivery',
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * What was paid, how and when — in plain words. A COD order is not "paid"
 * until the courier collects it, and must not read as if it were.
 */
function paymentState(order: OrderDetailView): { line: string; detail: string | null; totalLabel: string } {
  const status = order.payment?.status;
  const when = order.payment?.paidAt ? ` on ${fmtDateTime(order.payment.paidAt)}` : '';
  if (order.paymentMethod === 'COD') {
    if (status === 'PAID') return { line: `Paid in cash on delivery${when}`, detail: null, totalLabel: 'Total paid' };
    if (status === 'REFUNDED') return { line: `Paid in cash on delivery${when}, refunded`, detail: null, totalLabel: 'Total paid' };
    return { line: 'Cash on Delivery — payable on delivery', detail: null, totalLabel: 'Payable on delivery' };
  }
  const by = `Paid by ${METHOD_LABELS[order.paymentMethod] ?? order.paymentMethod}${when}`;
  const txn = order.payment?.transactionId ? `Txn: ${order.payment.transactionId}` : null;
  if (status === 'PAID') return { line: by, detail: txn, totalLabel: 'Total paid' };
  if (status === 'REFUNDED') return { line: `${by}, refunded`, detail: txn, totalLabel: 'Total paid' };
  return { line: 'Payment pending', detail: null, totalLabel: 'Amount due' };
}

/**
 * The buyer's tax invoices. Each seller on the order issues its own, under
 * its GSTIN, for its lines; the order summary below adds delivery and any
 * coupon or credits. "Download" is the browser's own print-to-PDF.
 */
export default function InvoicePage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = use(paramsPromise);
  const [order, setOrder] = useState<OrderDetailView | null>(null);
  const [invoices, setInvoices] = useState<TaxInvoice[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [notIssued, setNotIssued] = useState(false);

  useEffect(() => {
    api<OrderDetailView>(`/api/orders/${params.id}`, { auth: true })
      .then(setOrder)
      .catch(() => setNotFound(true));
    api<TaxInvoice[]>(`/api/orders/${params.id}/invoices`, { auth: true })
      .then(setInvoices)
      .catch(() => setNotIssued(true));
  }, [params.id]);

  if (notFound) {
    return (
      <div className="py-20 text-center">
        <h1 className="t-page-title text-ink-900">Order not found</h1>
        <Link href="/account/orders" className="t-btn mt-6 inline-block text-brand-600 underline">
          Back to my orders
        </Link>
      </div>
    );
  }
  if (!order || (!invoices && !notIssued)) return <div className="h-96 animate-pulse rounded-2xl bg-cream-100" />;

  const pay = paymentState(order);
  const paymentNote = (
    <>
      <span className="font-semibold text-ink-900">{pay.line}</span>
      {pay.detail && (
        <>
          <br />
          <span className="break-all">{pay.detail}</span>
        </>
      )}
    </>
  );
  const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
  const creditsDiscount = order.discountPaise - order.couponDiscountPaise;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/account/orders/${order.id}`} className="t-caption text-gray-500 hover:text-brand-600">
          ‹ Back to order
        </Link>
        {invoices && invoices.length > 0 && (
          <button
            onClick={() => window.print()}
            className="t-btn rounded-lg bg-ink-900 px-5 py-2.5 text-white transition hover:bg-ink-800"
          >
            ⬇ Download / Print
          </button>
        )}
      </div>

      {notIssued || !invoices || invoices.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white p-6 text-sm text-gray-600">
          The tax invoice is issued once your payment is confirmed. {pay.line}.
        </div>
      ) : (
        invoices.map((invoice) => <TaxInvoiceDocument key={invoice.invoiceNumber} invoice={invoice} payment={paymentNote} />)
      )}

      <section className="rounded-2xl border border-gray-100 bg-white p-6">
        <p className="t-caption font-bold uppercase tracking-wide text-gray-500">Order {order.orderNumber} — summary</p>
        <dl className="mt-3 ml-auto max-w-xs space-y-2">
          <div className="flex justify-between">
            <dt className="t-caption text-gray-600">Item total ({itemCount} items)</dt>
            <dd className="t-caption font-semibold text-ink-900">{formatPaise(order.subtotalPaise)}</dd>
          </div>
          {order.couponDiscountPaise > 0 && (
            <div className="flex justify-between">
              <dt className="t-caption text-gray-600">Coupon ({order.couponCode})</dt>
              <dd className="t-caption font-semibold text-green-700">−{formatPaise(order.couponDiscountPaise)}</dd>
            </div>
          )}
          {order.creditsUsed > 0 && (
            <div className="flex justify-between">
              <dt className="t-caption text-gray-600">Clowe Credits ({order.creditsUsed})</dt>
              <dd className="t-caption font-semibold text-green-700">−{formatPaise(creditsDiscount)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="t-caption text-gray-600">Delivery</dt>
            <dd className="t-caption font-semibold text-ink-900">
              {order.shippingPaise === 0 ? 'FREE' : formatPaise(order.shippingPaise)}
            </dd>
          </div>
          <div className="flex justify-between border-t border-gray-200 pt-2">
            <dt className="t-card-label text-ink-900">{pay.totalLabel}</dt>
            <dd className="t-cart-price text-ink-900">{formatPaise(order.totalPaise)}</dd>
          </div>
        </dl>
        <p className="t-caption mt-3 text-gray-500">{pay.line}</p>
      </section>
    </div>
  );
}
