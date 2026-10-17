'use client';

import { useState } from 'react';
import type { SellerParcelView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { NdrActions } from '@/components/NdrActions';

/**
 * What needs the seller about this order's parcels: a failed delivery
 * attempt (try again, another day, a corrected address, or back to the
 * seller), a parcel on
 * its way back, or one back with them to check. Nothing when all is well.
 */
export function ParcelIssues({
  parcels,
  buyerRtoCount,
  onChanged,
  flash,
}: {
  parcels: SellerParcelView[];
  buyerRtoCount: number;
  onChanged: () => void;
  flash: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const issues = parcels.filter(
    (p) => p.status === 'DELIVERY_FAILED' || p.status === 'RTO_IN_TRANSIT' || (p.status === 'RTO_DELIVERED' && !p.rtoReceivedCondition),
  );
  if (issues.length === 0 && buyerRtoCount === 0) return null;

  async function post(parcelId: string, path: string, body: unknown, done: string) {
    if (busy) return;
    setBusy(`${parcelId}:${done}`);
    setError('');
    try {
      await api(`/api/seller/orders/parcels/${parcelId}/${path}`, { method: 'POST', body, auth: true, success: done });
      flash(done);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'That did not go through');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-2" data-parcel-issues>
      {buyerRtoCount > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          This buyer has had {buyerRtoCount} parcel{buyerRtoCount === 1 ? '' : 's'} come back undelivered before.
        </p>
      )}
      {issues.map((p) => (
        <div key={p.id} className="rounded-2xl border border-amber-200 bg-amber-50/60 p-3 text-xs" data-parcel-issue={p.status}>
          {p.status === 'DELIVERY_FAILED' && (
            <NdrActions
              path={`/api/seller/orders/parcels/${p.id}/ndr`}
              awbNumber={p.awbNumber}
              reason={p.statusText}
              attempts={p.deliveryAttempts}
              ndrAction={p.ndrAction}
              ndrActionAt={p.ndrActionAt}
              deliverTo={p.deliverTo}
              canEditPhone={false}
              onDone={(message) => {
                flash(message);
                onChanged();
              }}
            />
          )}
          {p.status === 'RTO_IN_TRANSIT' && (
            <p className="text-gray-700">
              <span className="font-semibold text-ink-900">Coming back to you — AWB {p.awbNumber}.</span> Delhivery couldn&apos;t
              deliver it and is returning it to your pickup address.
            </p>
          )}
          {p.status === 'RTO_DELIVERED' && !p.rtoReceivedCondition && (
            <>
              <p className="font-semibold text-ink-900">Back with you — AWB {p.awbNumber}. How did it come back?</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void post(p.id, 'rto-received', { condition: 'GOOD' }, 'Checked: its stock is back on sale.')}
                  className="rounded-lg bg-ink-900 px-3 py-1.5 font-bold uppercase tracking-wide text-white disabled:opacity-50"
                >
                  {busy === `${p.id}:Checked: its stock is back on sale.` && <Spinner className="mr-1" />}
                  Good — put stock back
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void post(p.id, 'rto-received', { condition: 'DAMAGED' }, 'Reported damaged: our team will look at it.')}
                  className="rounded-lg border border-red-300 bg-white px-3 py-1.5 font-semibold text-red-600 disabled:opacity-50"
                >
                  {busy === `${p.id}:Reported damaged: our team will look at it.` && <Spinner className="mr-1" />}
                  Damaged
                </button>
              </div>
            </>
          )}
        </div>
      ))}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
    </section>
  );
}
