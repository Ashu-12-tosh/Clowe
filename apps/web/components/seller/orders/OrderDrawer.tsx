'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ORDER_STATUS_LABELS, type SellerOrderRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

export const STATUS_STYLES: Record<string, string> = {
  CONFIRMED: 'bg-blue-100 text-blue-700',
  PACKED: 'bg-indigo-100 text-indigo-700',
  SHIPPED: 'bg-purple-100 text-purple-700',
  DELIVERED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-100 text-orange-700',
  RETURNED: 'bg-red-100 text-red-700',
  PLACED: 'bg-yellow-100 text-yellow-700',
};

export function StatusPill({ status, mixed }: { status: string; mixed?: boolean }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${
        STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-600'
      }`}
    >
      {ORDER_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')}
      {mixed && <span title="Your items are in different stages"> +</span>}
    </span>
  );
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

/**
 * Full detail for one order: every line the seller owns, its fulfilment
 * timeline, and the actions available on it right now.
 */
export default function OrderDrawer({
  orderId,
  couriers,
  onClose,
  onChanged,
}: {
  orderId: string;
  couriers: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [order, setOrder] = useState<SellerOrderRow | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [courier, setCourier] = useState('');

  const load = () => {
    api<SellerOrderRow>(`/api/seller/orders/${orderId}`, { auth: true })
      .then(setOrder)
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load this order'),
      );
  };

  useEffect(load, [orderId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function act(itemId: string, action: 'pack' | 'ship' | 'deliver') {
    setBusyId(itemId);
    setError('');
    try {
      await api(`/api/seller/orders/${itemId}/status`, {
        method: 'PATCH',
        body: { action, ...(action === 'ship' && courier ? { courier } : {}) },
        auth: true,
      });
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-900/40" onClick={onClose}>
      <aside
        className="h-full w-full max-w-lg overflow-y-auto bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4">
          <div>
            <p className="font-mono text-sm font-bold text-brand-600">
              {order?.orderNumber ?? 'Loading…'}
            </p>
            {order && (
              <p className="text-xs text-gray-500">
                Placed {fmt(order.placedAt)} · {order.itemCount} item(s) ·{' '}
                {formatPaise(order.amountPaise)}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-full px-3 py-1 text-sm text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </header>

        {error && <p className="mx-5 mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!order && !error && <p className="p-5 text-sm text-gray-500">Loading…</p>}

        {order && (
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-4 rounded-2xl border border-gray-100 p-4 text-xs">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400">Customer</p>
                <p className="mt-0.5 text-sm font-semibold text-ink-900">{order.customer.name}</p>
                <p className="text-gray-500">+91 {order.customer.phone}</p>
                {order.customer.email && <p className="text-gray-500">{order.customer.email}</p>}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400">Payment</p>
                <p className="mt-0.5 text-sm font-semibold text-ink-900">
                  {order.isCod ? 'Cash on Delivery' : order.paymentMethod}
                </p>
                <p className="text-gray-500">{order.paymentStatus}</p>
                {order.isCod && (
                  <p className="mt-1 rounded bg-yellow-50 px-2 py-1 text-[11px] font-semibold text-yellow-800">
                    Collect {formatPaise(order.amountPaise)} on delivery
                  </p>
                )}
              </div>
              <div className="col-span-2">
                <p className="text-[11px] uppercase tracking-wide text-gray-400">Ship to</p>
                <p className="mt-0.5 text-sm text-ink-900">{order.shipTo.name}</p>
                <p className="leading-relaxed text-gray-600">
                  {order.shipTo.line1}
                  {order.shipTo.line2 && <>, {order.shipTo.line2}</>}
                  <br />
                  {order.shipTo.city}, {order.shipTo.state} — {order.shipTo.pincode}
                  <br />
                  Phone: {order.shipTo.phone}
                </p>
                <p className="mt-1 text-gray-500">
                  Delivery: {order.deliveryMethod.replace(/_/g, ' ')}
                  {order.isGift && ' · 🎁 Gift order'}
                </p>
              </div>
            </div>

            {couriers.length > 0 && order.lines.some((l) => l.canShip) && (
              <div className="rounded-2xl border border-gray-100 p-4">
                <label className="text-xs font-semibold text-gray-500">
                  Courier for the next shipment
                </label>
                <select
                  value={courier}
                  onChange={(e) => setCourier(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-600"
                >
                  <option value="">Auto-assign (cheapest available)</option>
                  {couriers.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {order.lines.map((line) => (
              <div key={line.id} className="rounded-2xl border border-gray-100 p-4">
                <div className="flex gap-3">
                  {line.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={line.imageUrl}
                      alt=""
                      className="h-20 w-16 rounded-lg border border-gray-200 object-cover"
                    />
                  ) : (
                    <div className="h-20 w-16 rounded-lg bg-cream-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/products/${line.slug}`}
                        className="text-sm font-semibold text-ink-900 hover:text-brand-600"
                      >
                        {line.title}
                      </Link>
                      <StatusPill status={line.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {line.color} / {line.size} · Qty {line.quantity} ·{' '}
                      {formatPaise(line.pricePaise * line.quantity)}
                    </p>
                    {line.awbNumber && (
                      <p className="mt-1 text-xs text-gray-600">
                        {line.courierName} · AWB{' '}
                        <span className="font-mono font-semibold">{line.awbNumber}</span>
                      </p>
                    )}
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-gray-100 pt-2 text-[11px] text-gray-500">
                  <div>
                    <dt className="uppercase tracking-wide text-gray-400">Packed</dt>
                    <dd>{fmt(line.packedAt)}</dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-wide text-gray-400">Shipped</dt>
                    <dd>{fmt(line.shippedAt)}</dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-wide text-gray-400">Delivered</dt>
                    <dd>{fmt(line.deliveredAt)}</dd>
                  </div>
                </dl>

                <div className="mt-3 flex flex-wrap gap-2">
                  {line.canPack && (
                    <button
                      disabled={busyId === line.id}
                      onClick={() => void act(line.id, 'pack')}
                      className="rounded-lg border border-ink-900 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide hover:bg-cream-100 disabled:opacity-50"
                    >
                      📦 Mark packed
                    </button>
                  )}
                  {line.canShip && (
                    <button
                      disabled={busyId === line.id}
                      onClick={() => void act(line.id, 'ship')}
                      className="rounded-lg bg-ink-900 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                    >
                      🚚 Ship{courier ? ` via ${courier}` : ''}
                    </button>
                  )}
                  {line.canDeliver && (
                    <button
                      disabled={busyId === line.id}
                      onClick={() => void act(line.id, 'deliver')}
                      className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      ✓ Mark delivered
                    </button>
                  )}
                  <a
                    href={`/seller/orders/labels?ids=${line.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-gray-300 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
                  >
                    🏷 Label
                  </a>
                  {line.returnId && (
                    <Link
                      href={`/seller/returns/${line.returnId}`}
                      className="rounded-lg border border-orange-300 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-orange-600 hover:bg-orange-50"
                    >
                      Return ({line.returnStatus}) →
                    </Link>
                  )}
                </div>
              </div>
            ))}

            <div className="flex flex-wrap gap-2">
              <a
                href={`/seller/orders/invoice?orderId=${order.orderId}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
              >
                🧾 Generate invoice
              </a>
              <a
                href={`/seller/orders/labels?ids=${order.lines.map((l) => l.id).join(',')}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
              >
                🏷 All labels
              </a>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
