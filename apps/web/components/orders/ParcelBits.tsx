'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { LostParcelChoice, OrderDetailItem } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/**
 * A line's parcel lost in transit (Shipping Policy 9.2): the buyer's choice of
 * a replacement or a refund. Where it is and when it arrives is the tracking
 * bar's (TrackingBar).
 */
export function ParcelStatus({
  orderId,
  item,
  onChanged,
}: {
  orderId: string;
  item: OrderDetailItem;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<LostParcelChoice | null>(null);
  const [error, setError] = useState('');
  const parcel = item.parcel;
  if (!parcel && !item.replacedBy) return null;

  async function choose(choice: LostParcelChoice) {
    if (!parcel) return;
    setBusy(choice);
    setError('');
    try {
      await api(`/api/orders/${orderId}/lost-parcels/${parcel.shipmentId}/choice`, { auth: true, quiet: true, body: { choice } });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save your choice — please try again');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-1.5 space-y-1" data-parcel>
      {parcel?.lost && !parcel.lostChoice && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3" data-lost-choice>
          <p className="t-caption font-bold text-red-700">This parcel is lost in transit</p>
          <p className="t-caption mt-0.5 text-red-700">
            We are sorry. Choose a free replacement, or a full refund of the {formatPaise(item.pricePaise * item.quantity)} you paid
            for it. If the item is out of stock, you get the refund.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => void choose('REPLACEMENT')}
              disabled={busy !== null}
              className="t-caption rounded-lg bg-ink-900 px-3 py-1.5 font-bold text-white disabled:opacity-50"
            >
              {busy === 'REPLACEMENT' ? 'Sending…' : 'Send a replacement'}
            </button>
            <button
              onClick={() => void choose('REFUND')}
              disabled={busy !== null}
              className="t-caption rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-bold text-ink-900 disabled:opacity-50"
            >
              {busy === 'REFUND' ? 'Refunding…' : 'Refund me'}
            </button>
          </div>
          {error && <p className="t-caption mt-1 text-red-700">{error}</p>}
        </div>
      )}
      {parcel?.lost && parcel.lostChoice === 'REFUND' && (
        <p className="t-caption font-semibold text-gray-700">Lost in transit — refunded</p>
      )}
      {item.replacedBy && (
        <p className="t-caption font-semibold text-gray-700">
          Replacement:{' '}
          <Link href={`/account/orders/${item.replacedBy.orderId}`} className="text-brand-600 hover:underline">
            {item.replacedBy.orderNumber}
          </Link>
        </p>
      )}
    </div>
  );
}
