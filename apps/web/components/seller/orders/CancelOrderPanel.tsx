'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ORDER_CANCEL_REASONS, type SellerOrderCancelResult, type SellerPenaltiesView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { toast } from '@/lib/toast';
import Spinner from '@/components/Spinner';
import { formatPaise } from '@/lib/format';

const OTHER = 'Other';

/**
 * "Can't fulfil this order?" — the seller cancels their part of an order that
 * has not shipped, all of it or the items they pick (Cancellation Policy 3.1).
 * Says up front what it costs (the penalty) and what happens for the buyer
 * (refund), and asks why from the policy's reasons: the reason goes to the
 * buyer and onto the penalty.
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
  cancellableLines: { id: string; title: string; label: string }[];
  onCancelled: (result: SellerOrderCancelResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [choice, setChoice] = useState<string>(ORDER_CANCEL_REASONS[0]);
  const [other, setOther] = useState('');
  const reason = choice === OTHER ? other : choice;
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

  if (cancellableLines.length === 0) return null;
  const chosen = picked.filter((id) => cancellableLines.some((l) => l.id === id));
  const all = chosen.length === 0 || chosen.length === cancellableLines.length;

  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<SellerOrderCancelResult>(`/api/seller/orders/${orderId}/cancel`, {
        method: 'POST',
        body: { reason: reason.trim(), ...(all ? {} : { itemIds: chosen }) },
        auth: true,
      });
      setOpen(false);
      setOther('');
      setPicked([]);
      toast.success(
        `${result.cancelledLines} item(s) cancelled` +
          (result.refund ? ` — ${formatPaise(result.refund.amountPaise)} refunded to the buyer` : '') +
          (result.penaltyPaise > 0 ? `; ${formatPaise(result.penaltyPaise)} cancellation penalty (see Penalties)` : ''),
      );
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
            Cancel your {cancellableLines.length === 1 ? 'item' : `${cancellableLines.length} items, or some of them,`} that haven&apos;t shipped.
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
          {cancellableLines.length > 1 && (
            <fieldset className="space-y-1">
              <legend className="text-xs font-semibold text-gray-600">Which items? (none ticked = all of them)</legend>
              {cancellableLines.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-xs text-gray-700">
                  <input
                    type="checkbox"
                    name="cancelItem"
                    checked={picked.includes(l.id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id)))}
                    className="h-4 w-4 accent-red-600"
                  />
                  {l.title}
                  {l.label && <span className="text-gray-400">· {l.label}</span>}
                </label>
              ))}
            </fieldset>
          )}
          <label className="block text-xs font-semibold text-gray-600">
            Why can&apos;t you fulfil it? (the buyer sees this)
            <select
              name="cancelReason"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-red-400"
            >
              {[...ORDER_CANCEL_REASONS, OTHER].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          {choice === OTHER && (
            <textarea
              value={other}
              onChange={(e) => setOther(e.target.value)}
              maxLength={300}
              rows={2}
              placeholder="Say why, in a few words"
              aria-label="Other reason"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-red-400"
            />
          )}
          {error && <p className="text-xs text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={busy || reason.trim().length < 5}
              className="rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? <><Spinner className="mr-1" />Cancelling…</> : 'Cancel my items'}
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
