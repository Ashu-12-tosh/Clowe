'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { OrderDetailView } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';

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
 * Printable invoice. "Download" is the browser's own print-to-PDF, so there is
 * no PDF dependency and the output matches what is on screen.
 */
export default function InvoicePage({ params }: { params: { id: string } }) {
  const [order, setOrder] = useState<OrderDetailView | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api<OrderDetailView>(`/api/orders/${params.id}`, { auth: true })
      .then(setOrder)
      .catch(() => setNotFound(true));
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
  if (!order) return <div className="h-96 animate-pulse rounded-2xl bg-cream-100" />;

  const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
  const creditsDiscount = order.discountPaise - order.couponDiscountPaise;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/account/orders/${order.id}`} className="t-caption text-gray-500 hover:text-brand-600">
          ‹ Back to order
        </Link>
        <button
          onClick={() => window.print()}
          className="t-btn rounded-lg bg-ink-900 px-5 py-2.5 text-white transition hover:bg-ink-800"
        >
          ⬇ Download / Print
        </button>
      </div>

      <article className="rounded-2xl border border-gray-100 bg-white p-6 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-5">
          <div>
            <p className="t-logo-sm uppercase text-ink-900">Clowe</p>
            <p className="t-caption mt-1 text-gray-500">Clowe E-Commerce · India</p>
          </div>
          <div className="text-right">
            <p className="t-sub-heading text-ink-900">Tax Invoice</p>
            <p className="t-caption text-gray-500">Order {order.orderNumber}</p>
            <p className="t-caption text-gray-500">{fmtDateTime(order.createdAt)}</p>
          </div>
        </header>

        <section className="grid gap-5 border-b border-gray-200 py-5 sm:grid-cols-2">
          <div>
            <p className="t-caption font-bold uppercase tracking-wide text-gray-500">Billed to</p>
            <p className="t-card-label mt-1.5 text-ink-900">{order.shipTo.name}</p>
            <p className="t-caption leading-relaxed text-gray-600">
              {order.shipTo.line1}
              {order.shipTo.line2 ? `, ${order.shipTo.line2}` : ''}
              <br />
              {order.shipTo.city}, {order.shipTo.state} - {order.shipTo.pincode}
              <br />
              +91 {order.shipTo.phone}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="t-caption font-bold uppercase tracking-wide text-gray-500">Payment</p>
            <p className="t-caption mt-1.5 text-gray-600">
              {order.payment?.status === 'PAID' ? 'Paid' : 'Pending'} via{' '}
              {order.payment?.provider ?? '—'}
            </p>
            {order.payment?.transactionId && (
              <p className="t-caption break-all text-gray-600">
                Txn: {order.payment.transactionId}
              </p>
            )}
            {order.payment?.paidAt && (
              <p className="t-caption text-gray-600">{fmtDateTime(order.payment.paidAt)}</p>
            )}
          </div>
        </section>

        <table className="mt-5 w-full">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="t-table-head py-2 text-gray-500">Item</th>
              <th className="t-table-head py-2 text-gray-500">Qty</th>
              <th className="t-table-head py-2 text-right text-gray-500">Unit</th>
              <th className="t-table-head py-2 text-right text-gray-500">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {order.items.map((item) => (
              <tr key={item.id}>
                <td className="t-table-cell py-2.5 text-ink-900">
                  {item.title}
                  <span className="t-caption block text-gray-500">
                    {item.variantLabel ? ` · ` : ''}sold by {item.shopName}
                  </span>
                </td>
                <td className="t-table-cell py-2.5 text-gray-600">{item.quantity}</td>
                <td className="t-table-cell py-2.5 text-right text-gray-600">
                  {formatPaise(item.pricePaise)}
                </td>
                <td className="t-table-cell py-2.5 text-right font-semibold text-ink-900">
                  {formatPaise(item.pricePaise * item.quantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="mt-5 flex justify-end">
          <dl className="w-full max-w-xs space-y-2">
            <div className="flex justify-between">
              <dt className="t-caption text-gray-600">Item total ({itemCount} items)</dt>
              <dd className="t-caption font-semibold text-ink-900">
                {formatPaise(order.subtotalPaise)}
              </dd>
            </div>
            {order.couponDiscountPaise > 0 && (
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Coupon ({order.couponCode})</dt>
                <dd className="t-caption font-semibold text-green-700">
                  −{formatPaise(order.couponDiscountPaise)}
                </dd>
              </div>
            )}
            {order.creditsUsed > 0 && (
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Clowe Credits ({order.creditsUsed})</dt>
                <dd className="t-caption font-semibold text-green-700">
                  −{formatPaise(creditsDiscount)}
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="t-caption text-gray-600">Shipping</dt>
              <dd className="t-caption font-semibold text-ink-900">
                {order.shippingPaise === 0 ? 'FREE' : formatPaise(order.shippingPaise)}
              </dd>
            </div>
            <div className="flex justify-between border-t border-gray-200 pt-2">
              <dt className="t-card-label text-ink-900">Total paid</dt>
              <dd className="t-cart-price text-ink-900">{formatPaise(order.totalPaise)}</dd>
            </div>
          </dl>
        </section>

        <footer className="mt-6 border-t border-gray-200 pt-4">
          <p className="t-caption text-gray-500">
            Amounts are inclusive of all applicable taxes. This is a computer-generated invoice and
            does not require a signature.
          </p>
        </footer>
      </article>
    </div>
  );
}
