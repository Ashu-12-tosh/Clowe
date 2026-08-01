'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  RETURN_REASONS,
  RETURN_REASON_LABELS,
  RETURN_REASONS_NEED_PHOTOS,
  type OrderDetailItem,
  type OrderDetailView,
  type ReturnInfo,
  type ReturnReasonValue,
} from '@clowe/shared';
import { api, ApiRequestError, uploadImages } from '@/lib/api';
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

/** Return status timeline: Requested → Approved → Item received → Refunded. */
function ReturnTimeline({ info }: { info: ReturnInfo }) {
  if (info.status === 'REJECTED') {
    return (
      <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        <span className="font-semibold">Return declined</span>
        {info.rejectionReason ? <> — {info.rejectionReason}</> : null}
        <p className="mt-1 text-red-600/80">
          Disagree? Raise a complaint from Support and our team will review it.
        </p>
      </div>
    );
  }

  const steps = [
    { key: 'REQUESTED', label: 'Requested', done: true },
    { key: 'APPROVED', label: 'Approved · pickup scheduled', done: !!info.approvedAt },
    { key: 'RECEIVED', label: 'Item received', done: !!info.receivedAt },
    { key: 'REFUNDED', label: 'Refund processed', done: info.status === 'REFUNDED' },
  ];
  return (
    <div className="mt-2 rounded-lg border border-brand-100 bg-brand-50/50 px-3 py-2.5">
      <p className="text-[11px] font-bold uppercase tracking-wide text-brand-700">Return status</p>
      <div className="mt-1.5 space-y-1">
        {steps.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span
              className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold ${
                s.done ? 'bg-brand-600 text-white' : 'border border-gray-300 bg-white text-gray-300'
              }`}
            >
              {s.done ? '✓' : ''}
            </span>
            <span className={s.done ? 'font-semibold text-ink-900' : 'text-gray-400'}>{s.label}</span>
          </div>
        ))}
      </div>
      {info.refund && (
        <p className="mt-2 border-t border-brand-100 pt-1.5 text-xs text-gray-600">
          {info.refund.status === 'PROCESSED' ? (
            <>
              💸 <span className="font-semibold">{formatPaise(info.refund.amountPaise)} refunded</span> — it
              should reflect in your account within 5–7 business days.
            </>
          ) : (
            <>
              💰 Refund of <span className="font-semibold">{formatPaise(info.refund.amountPaise)}</span>{' '}
              initiated — expect it within 5–7 business days.
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** Return request modal: reason + details + photos (theme card, mobile sheet). */
function ReturnModal({
  item,
  onClose,
  onDone,
}: {
  item: OrderDetailItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState<ReturnReasonValue | ''>('');
  const [details, setDetails] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const needsPhotos = reason !== '' && RETURN_REASONS_NEED_PHOTOS.includes(reason);

  async function submit() {
    if (!reason) return;
    if (reason === 'OTHER' && details.trim().length < 5) {
      setError('Please describe the issue (min 5 characters)');
      return;
    }
    if (needsPhotos && files.length === 0) {
      setError('Please add at least one photo of the item');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const photos = files.length > 0 ? await uploadImages(files) : [];
      await api(`/api/orders/items/${item.id}/return`, {
        body: { reason, details: details.trim() || undefined, photos },
        auth: true,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:max-w-md sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-ink-900">Return item</h2>
            <p className="mt-0.5 text-xs text-gray-500">{item.title}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-xl leading-none text-gray-400 hover:bg-cream-100">
            ×
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <p className="mt-4 text-sm font-semibold text-ink-900">Why are you returning this?</p>
        <div className="mt-2 space-y-1.5">
          {RETURN_REASONS.map((r) => (
            <label
              key={r}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition ${
                reason === r ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="return-reason"
                checked={reason === r}
                onChange={() => setReason(r)}
                className="accent-brand-600"
              />
              {RETURN_REASON_LABELS[r]}
            </label>
          ))}
        </div>

        {reason && (
          <>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              maxLength={300}
              rows={2}
              placeholder={reason === 'OTHER' ? 'Describe the issue *' : 'Any details for the seller (optional)'}
              className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
            />

            <p className="mt-2 text-sm font-semibold text-ink-900">
              Photos {needsPhotos ? <span className="text-red-600">*</span> : <span className="font-normal text-gray-400">(optional)</span>}
              <span className="ml-1 text-xs font-normal text-gray-400">up to 3</span>
            </p>
            <div className="mt-1.5 flex gap-2">
              {files.map((f, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={URL.createObjectURL(f)} alt="" className="h-16 w-16 rounded-lg object-cover" />
                  <button
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink-900 text-xs text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
              {files.length < 3 && (
                <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-2xl text-gray-400 hover:border-brand-600 hover:text-brand-600">
                  +
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setFiles((prev) => [...prev, f].slice(0, 3));
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
          </>
        )}

        <button
          onClick={() => void submit()}
          disabled={busy || !reason}
          className="mt-5 w-full rounded-xl bg-brand-600 py-2.5 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'Submit return request'}
        </button>
      </div>
    </div>
  );
}

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

  const [returnItem, setReturnItem] = useState<OrderDetailItem | null>(null);

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
                {item.canReturn && (
                  <button
                    onClick={() => setReturnItem(item)}
                    className="text-xs font-medium text-orange-600 hover:underline"
                  >
                    Request return
                  </button>
                )}
                {item.status === 'DELIVERED' && !item.canReturn && !item.returnInfo && (
                  <span className="text-xs text-gray-400">
                    Return window closed ({order.returnWindowDays} days from delivery)
                  </span>
                )}
              </div>
              {item.canReturn && (
                <p className="mt-1 text-[11px] text-gray-400">
                  Easy returns within {order.returnWindowDays} days of delivery
                </p>
              )}
              {item.returnInfo && <ReturnTimeline info={item.returnInfo} />}
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
            {order.discountPaise > 0 && (
              <div className="flex justify-between text-brand-700">
                <dt>Credits discount ({order.creditsUsed} 🪙)</dt>
                <dd className="font-semibold">− {formatPaise(order.discountPaise)}</dd>
              </div>
            )}
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

      {returnItem && (
        <ReturnModal
          item={returnItem}
          onClose={() => setReturnItem(null)}
          onDone={() => {
            setReturnItem(null);
            load();
          }}
        />
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
