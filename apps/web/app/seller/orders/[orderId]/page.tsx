'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { SellerOrderBulkResult, SellerOrderRow, SellerOrderSummary } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { StatusPill } from '@/components/seller/orders/StatusPill';

type Action = 'pack' | 'ship' | 'deliver';

function fmt(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
}

const CARD = 'rounded-2xl border border-gray-100 bg-white p-4';
const LABEL = 'text-[11px] uppercase tracking-wide text-gray-400';

/**
 * Dedicated page for one order: every line the seller owns, its fulfilment
 * timeline and all the actions on it — replaces the old side drawer.
 * The buyer is shown as name + delivery address only; the API never sends
 * their phone number or email to sellers.
 */
export default function SellerOrderDetailPage({ params }: { params: { orderId: string } }) {
  const [order, setOrder] = useState<SellerOrderRow | null>(null);
  const [couriers, setCouriers] = useState<string[]>([]);
  const [courier, setCourier] = useState('');
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** Line id while a single line is updating, or 'all' during a bulk action. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Line to highlight - a scanned label QR lands here with ?item=<lineId>. */
  const [focusItemId, setFocusItemId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<SellerOrderRow>(`/api/seller/orders/${params.orderId}`, { auth: true })
      .then(setOrder)
      .catch((err) =>
        setLoadError(err instanceof ApiRequestError ? err.message : 'Could not load this order'),
      );
  }, [params.orderId]);
  useEffect(load, [load]);

  useEffect(() => {
    setFocusItemId(new URLSearchParams(window.location.search).get('item'));
  }, []);
  useEffect(() => {
    if (!order || !focusItemId) return;
    document.getElementById(`line-${focusItemId}`)?.scrollIntoView({ block: 'center' });
  }, [order, focusItemId]);

  // Courier choices come from the shipping provider via the summary endpoint.
  useEffect(() => {
    api<SellerOrderSummary>('/api/seller/orders/summary', { auth: true })
      .then((s) => setCouriers(s.couriers))
      .catch(() => {});
  }, []);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(''), 5000);
  }

  async function act(itemId: string, action: Action) {
    setBusy(itemId);
    setError('');
    try {
      await api(`/api/seller/orders/${itemId}/status`, {
        method: 'PATCH',
        body: { action, ...(action === 'ship' && courier ? { courier } : {}) },
        auth: true,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  /** Move every line that is eligible for `action` in one go. */
  async function actAll(action: Action) {
    if (!order) return;
    const itemIds = order.lines
      .filter((l) => (action === 'pack' ? l.canPack : action === 'ship' ? l.canShip : l.canDeliver))
      .map((l) => l.id);
    if (itemIds.length === 0) return;
    setBusy('all');
    setError('');
    try {
      const result = await api<SellerOrderBulkResult>('/api/seller/orders/bulk', {
        method: 'POST',
        body: { itemIds, action, ...(action === 'ship' && courier ? { courier } : {}) },
        auth: true,
      });
      flash(
        `${result.updated} item(s) updated` +
          (result.skipped.length > 0
            ? ` · ${result.skipped.length} skipped (${result.skipped[0].reason})`
            : ''),
      );
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Bulk action failed');
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div className="py-10 text-center text-sm text-gray-600">
        {loadError}.{' '}
        <Link href="/seller/orders" className="font-semibold text-brand-600 hover:underline">
          ← All orders
        </Link>
      </div>
    );
  }
  if (!order) return <p className="text-sm text-gray-500">Loading…</p>;

  const packable = order.lines.filter((l) => l.canPack).length;
  const shippable = order.lines.filter((l) => l.canShip).length;
  const deliverable = order.lines.filter((l) => l.canDeliver).length;
  const allItemIds = order.lines.map((l) => l.id).join(',');
  const shipToLine =
    order.shipTo.line1 + (order.shipTo.line2 ? `, ${order.shipTo.line2}` : '');

  return (
    <div className="pb-10">
      <Link href="/seller/orders" className="text-xs text-gray-400 hover:text-gray-600">
        ← All orders
      </Link>

      {/* --- Header --------------------------------------------------- */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-bold text-brand-600">{order.orderNumber}</h1>
            <StatusPill status={order.status} mixed={order.mixedStatus} />
            {order.isGift && (
              <span className="rounded-full bg-pink-50 px-2.5 py-1 text-[11px] font-semibold text-pink-700">
                🎁 Gift order
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            Placed {fmt(order.placedAt)} · {order.itemCount} item(s) · {order.unitCount} unit(s) ·
            your share <span className="font-semibold text-ink-900">{formatPaise(order.amountPaise)}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`/seller/orders/invoice?orderId=${order.orderId}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
          >
            🧾 Generate invoice
          </a>
          <a
            href={`/seller/orders/labels?ids=${allItemIds}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
          >
            🏷 All labels
          </a>
        </div>
      </div>

      {notice && (
        <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* --- Left: fulfilment ------------------------------------------ */}
        <div className="space-y-4">
          {(packable > 0 || shippable > 0 || deliverable > 0) && (
            <div className={`${CARD} flex flex-wrap items-center gap-2`}>
              <p className="mr-auto text-xs font-semibold text-gray-500">
                Fulfil every eligible item at once
              </p>
              {packable > 0 && (
                <button
                  disabled={busy !== null}
                  onClick={() => void actAll('pack')}
                  className="rounded-lg border border-ink-900 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide hover:bg-cream-100 disabled:opacity-50"
                >
                  📦 Mark all packed ({packable})
                </button>
              )}
              {shippable > 0 && (
                <button
                  disabled={busy !== null}
                  onClick={() => void actAll('ship')}
                  className="rounded-lg bg-ink-900 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                >
                  🚚 Ship all ({shippable}){courier ? ` via ${courier}` : ''}
                </button>
              )}
              {deliverable > 0 && (
                <button
                  disabled={busy !== null}
                  onClick={() => void actAll('deliver')}
                  className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  ✓ Mark all delivered ({deliverable})
                </button>
              )}
            </div>
          )}

          {order.lines.map((line) => (
            <div
              key={line.id}
              id={`line-${line.id}`}
              className={`${CARD} ${line.id === focusItemId ? 'ring-2 ring-brand-500' : ''}`}
            >
              <div className="flex gap-3">
                {line.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={line.imageUrl}
                    alt=""
                    className="h-24 w-20 rounded-lg border border-gray-200 object-cover"
                  />
                ) : (
                  <div className="h-24 w-20 rounded-lg bg-cream-100" />
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
                    {line.label ? ` · ` : ''}Qty {line.quantity} ·{' '}
                    {formatPaise(line.pricePaise)} each ·{' '}
                    <span className="font-semibold text-ink-900">
                      {formatPaise(line.pricePaise * line.quantity)}
                    </span>
                  </p>
                  {line.awbNumber && (
                    <p className="mt-1 text-xs text-gray-600">
                      {line.courierName} · AWB{' '}
                      <span className="font-mono font-semibold">{line.awbNumber}</span>
                      {line.trackingUrl && (
                        <>
                          {' · '}
                          <a
                            href={line.trackingUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold text-brand-600 hover:underline"
                          >
                            Track ↗
                          </a>
                        </>
                      )}
                    </p>
                  )}
                </div>
              </div>

              <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-gray-100 pt-2 text-[11px] text-gray-500">
                <div>
                  <dt className={LABEL}>Packed</dt>
                  <dd>{fmt(line.packedAt)}</dd>
                </div>
                <div>
                  <dt className={LABEL}>Shipped</dt>
                  <dd>{fmt(line.shippedAt)}</dd>
                </div>
                <div>
                  <dt className={LABEL}>Delivered</dt>
                  <dd>{fmt(line.deliveredAt)}</dd>
                </div>
              </dl>

              <div className="mt-3 flex flex-wrap gap-2">
                {line.canPack && (
                  <button
                    disabled={busy !== null}
                    onClick={() => void act(line.id, 'pack')}
                    className="rounded-lg border border-ink-900 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide hover:bg-cream-100 disabled:opacity-50"
                  >
                    📦 Mark packed
                  </button>
                )}
                {line.canShip && (
                  <button
                    disabled={busy !== null}
                    onClick={() => void act(line.id, 'ship')}
                    className="rounded-lg bg-ink-900 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                  >
                    🚚 Ship{courier ? ` via ${courier}` : ''}
                  </button>
                )}
                {line.canDeliver && (
                  <button
                    disabled={busy !== null}
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
        </div>

        {/* --- Right: customer, shipping, payment ------------------------ */}
        <aside className="space-y-4">
          <section className={`${CARD} text-xs`}>
            <p className={LABEL}>Customer</p>
            <p className="mt-0.5 text-sm font-semibold text-ink-900">{order.customer.name}</p>

            <p className={`${LABEL} mt-4`}>Ship to</p>
            <p className="mt-0.5 text-sm text-ink-900">{order.shipTo.name}</p>
            <p className="leading-relaxed text-gray-600">
              {shipToLine}
              <br />
              {order.shipTo.city}, {order.shipTo.state} — {order.shipTo.pincode}
            </p>
            <p className="mt-2 text-gray-500">
              Delivery: {order.deliveryMethod.replace(/_/g, ' ')}
            </p>
          </section>

          <section className={`${CARD} text-xs`}>
            <p className={LABEL}>Payment</p>
            <p className="mt-0.5 text-sm font-semibold text-ink-900">
              {order.isCod ? 'Cash on Delivery' : order.paymentMethod}
            </p>
            <p className="text-gray-500">{order.paymentStatus}</p>
            {order.isCod && (
              <p className="mt-2 rounded bg-yellow-50 px-2 py-1 text-[11px] font-semibold text-yellow-800">
                Collect {formatPaise(order.amountPaise)} on delivery
              </p>
            )}
            <dl className="mt-3 space-y-1 border-t border-gray-100 pt-2">
              <div className="flex justify-between">
                <dt className="text-gray-500">Your lines</dt>
                <dd className="font-semibold text-ink-900">{order.itemCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Units</dt>
                <dd className="font-semibold text-ink-900">{order.unitCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Your share</dt>
                <dd className="font-semibold text-ink-900">{formatPaise(order.amountPaise)}</dd>
              </div>
            </dl>
          </section>

          {couriers.length > 0 && shippable > 0 && (
            <section className={CARD}>
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
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
