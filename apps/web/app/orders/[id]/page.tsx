'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { OrderDetailView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import OrderStepper from '@/components/OrderStepper';

const statusStyles: Record<string, string> = {
  PLACED: 'bg-blue-100 text-blue-700',
  CONFIRMED: 'bg-blue-100 text-blue-700',
  SHIPPED: 'bg-purple-100 text-purple-700',
  DELIVERED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-100 text-orange-700',
  RETURNED: 'bg-red-100 text-red-700',
};

function OrderDetailInner({ orderId }: { orderId: string }) {
  const placed = useSearchParams().get('placed') === '1';
  const [order, setOrder] = useState<OrderDetailView | null>(null);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    api<OrderDetailView>(`/api/orders/${orderId}`, { auth: true })
      .then(setOrder)
      .catch(() => setNotFound(true));
  }, [orderId]);
  useEffect(load, [load]);

  async function cancelOrder() {
    if (!window.confirm('Cancel this whole order?')) return;
    setError('');
    try {
      await api(`/api/orders/${orderId}/cancel`, { method: 'POST', auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  async function requestReturn(itemId: string) {
    const reason = window.prompt('Why do you want to return this item?');
    if (reason === null) return;
    setError('');
    try {
      await api(`/api/orders/items/${itemId}/return`, { body: { reason }, auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Order not found</p>
        <Link href="/orders" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
          ← My orders
        </Link>
      </main>
    );
  }

  if (!order) {
    return <main className="mx-auto max-w-3xl px-4 py-10 text-sm text-gray-500">Loading…</main>;
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Link href="/orders" className="text-xs text-gray-400 hover:text-gray-600">
        ← My orders
      </Link>

      {placed && order.status === 'CONFIRMED' && (
        <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          🎉 <span className="font-semibold">Order placed!</span> Payment received — sellers have
          been notified.
        </div>
      )}

      {order.awaitingPayment && (
        <div className="mt-3 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          Payment pending — this order is not confirmed yet.
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{order.orderNumber}</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            Placed on{' '}
            {new Date(order.createdAt).toLocaleString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[order.status] ?? ''}`}>
          {order.status.replace('_', ' ')}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {order.items.map((item) => (
          <div key={item.id} className="flex gap-4 rounded-xl border border-gray-200 bg-white p-3">
            <Link href={`/products/${item.productSlug}`} className="shrink-0">
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.imageUrl} alt="" className="h-20 w-16 rounded-lg object-cover" />
              ) : (
                <div className="h-20 w-16 rounded-lg bg-gray-100" />
              )}
            </Link>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{item.title}</p>
              <p className="mt-0.5 text-xs text-gray-500">
                {item.color} / {item.size} · qty {item.quantity} · sold by {item.shopName}
              </p>
              {item.courierName && (
                <p className="mt-0.5 text-xs text-gray-600">
                  🚚 {item.courierName} · AWB <span className="font-mono">{item.awbNumber}</span>
                </p>
              )}
              <p className="mt-1 text-sm font-bold">{formatPaise(item.pricePaise * item.quantity)}</p>
              {item.status !== 'CANCELLED' &&
                item.status !== 'RETURN_REQUESTED' &&
                item.status !== 'RETURNED' && <OrderStepper status={item.status} />}
              <div className="mt-1.5 flex items-center gap-3">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusStyles[item.status] ?? ''}`}>
                  {item.status.replace('_', ' ')}
                </span>
                {item.status === 'DELIVERED' && !item.returnStatus && (
                  <button
                    onClick={() => void requestReturn(item.id)}
                    className="text-xs font-medium text-orange-600 hover:underline"
                  >
                    Request return
                  </button>
                )}
                {item.returnStatus && (
                  <span className="text-xs text-orange-600">Return: {item.returnStatus}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
          <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">Delivery address</h2>
          <p className="mt-2 font-semibold">{order.shipTo.name}</p>
          <p className="text-gray-600">
            {order.shipTo.line1}
            {order.shipTo.line2 ? `, ${order.shipTo.line2}` : ''}
            <br />
            {order.shipTo.city}, {order.shipTo.state} — {order.shipTo.pincode}
            <br />
            +91 {order.shipTo.phone}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
          <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">Payment</h2>
          <dl className="mt-2 space-y-1.5">
            <div className="flex justify-between">
              <dt className="text-gray-600">Subtotal</dt>
              <dd>{formatPaise(order.subtotalPaise)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-600">Shipping</dt>
              <dd>{order.shippingPaise === 0 ? 'FREE' : formatPaise(order.shippingPaise)}</dd>
            </div>
            <div className="flex justify-between border-t border-gray-100 pt-1.5 font-bold">
              <dt>Total</dt>
              <dd>{formatPaise(order.totalPaise)}</dd>
            </div>
            {order.payment && (
              <p className="pt-1 text-xs text-gray-500">
                via {order.payment.provider} · {order.payment.status}
              </p>
            )}
          </dl>
        </div>
      </div>

      {order.canCancel && (
        <button
          onClick={() => void cancelOrder()}
          className="mt-5 rounded-lg border border-red-300 px-5 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
        >
          Cancel order
        </button>
      )}
    </main>
  );
}

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <OrderDetailInner orderId={params.id} />
    </Suspense>
  );
}
