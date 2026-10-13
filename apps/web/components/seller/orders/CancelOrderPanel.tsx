'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SellerOrderCancelResult, SellerPenaltiesView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/**
 * "Can't fulfil this order?" — the seller cancels their part of an order that
 * has not shipped. Says up front what it costs (the penalty) and what happens
 * for the buyer (refund), and asks why: the reason goes to the buyer and onto
 * the penalty.
 */
export function CancelOrderPanel({
  orderId,
  placedAt,
  cancellableLines,
  onCancelled,
}: {
  orderId: string;
  /** When the order was placed: the penalty only applies from the rule's start. */
  placedAt: string;
  /** Your lines on this order that have not shipped. */
  cancellableLines: number;
  onCancelled: (result: SellerOrderCancelResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [penaltyPaise, setPenaltyPaise] = useState<number | null>(null);

  useEffect(() => {
    api<SellerPenaltiesView>('/api/seller/ledger/penalties', { auth: true })
      .then(({ cancelRule: r }) => {
        const applies = r.enabled && (!r.effectiveFrom || new Date(placedAt) >= new Date(r.effectiveFrom));
        setPenaltyPaise(applies ? r.penaltyPaise : 0);
      })
      .catch(() => {});
  }, [placedAt]);

  if (cancellableLines === 0) return null;

  async function cancel() {
    setBusy(true);
    setError('');
    try {
      const result = await api<SellerOrderCancelResult>(`/api/seller/orders/${orderId}/cancel`, {
        method: 'POST',
        body: { reason: reason.trim() },
        auth: true,
      });
      setOpen(false);
      setReason('');
      onCancelled(result);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not cancel the order');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-red-100 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-ink-900">Can&apos;t fulfil this order?</p>
          <p className="text-xs text-gray-500">
            Cancel your {cancellableLines === 1 ? 'item' : `${cancellableLines} items`} that haven&apos;t shipped.
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg border border-red-300 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50"
          >
            Cancel order
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
            {penaltyPaise ? (
              <>
                A <span className="font-bold">{formatPaise(penaltyPaise)} cancellation penalty</span> is charged to your
                payouts, once for this order.{' '}
              </>
            ) : null}
            The buyer is told why and refunded for your items. Cancelling often hurts your seller score.{' '}
            <Link href="/seller/penalties" className="font-semibold underline">
              Penalties
            </Link>
          </p>
          <label className="block text-xs font-semibold text-gray-600">
            Why can&apos;t you fulfil it? (the buyer sees this)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              rows={2}
              placeholder="e.g. Out of stock in this size"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-red-400"
            />
          </label>
          {error && <p className="text-xs text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={busy || reason.trim().length < 5}
              className="rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? 'Cancelling…' : 'Cancel my items'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded-lg border border-gray-300 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
            >
              Keep the order
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
