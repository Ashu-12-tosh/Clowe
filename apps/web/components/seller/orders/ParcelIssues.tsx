'use client';

import { useState } from 'react';
import type { SellerParcelView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

/** The next six days, as YYYY-MM-DD in India, for "deliver on another day". */
function nextDays(): { value: string; label: string }[] {
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.now() + (i + 1) * 86_400_000);
    return {
      value: d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
      label: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }),
    };
  });
}

/**
 * What needs the seller about this order's parcels: a failed delivery
 * attempt (ask Delhivery to try again, or deliver another day), a parcel on
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
  const [deferTo, setDeferTo] = useState<Record<string, string>>({});
  const days = nextDays();

  const issues = parcels.filter(
    (p) => p.status === 'DELIVERY_FAILED' || p.status === 'RTO_IN_TRANSIT' || (p.status === 'RTO_DELIVERED' && !p.rtoReceivedCondition),
  );
  if (issues.length === 0 && buyerRtoCount === 0) return null;

  async function post(parcelId: string, path: string, body: unknown, done: string) {
    setBusy(parcelId);
    setError('');
    try {
      await api(`/api/seller/orders/parcels/${parcelId}/${path}`, { method: 'POST', body, auth: true });
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
            <>
              <p className="font-semibold text-ink-900">Delivery attempt failed — AWB {p.awbNumber}</p>
              <p className="mt-0.5 text-gray-600">{p.statusText ?? 'Delhivery could not deliver it.'}</p>
              {p.ndrAction ? (
                <p className="mt-1 text-gray-600">
                  Asked Delhivery to {p.ndrAction === 'RE_ATTEMPT' ? 'try again' : 'deliver on another day'}
                  {p.ndrActionAt ? ` on ${new Date(p.ndrActionAt).toLocaleDateString('en-IN')}` : ''}.
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void post(p.id, 'ndr', { action: 'RE_ATTEMPT' }, 'Asked Delhivery to try again.')}
                    className="rounded-lg bg-ink-900 px-3 py-1.5 font-bold uppercase tracking-wide text-white disabled:opacity-50"
                  >
                    Try again
                  </button>
                  <span className="text-gray-500">or deliver on</span>
                  <select
                    aria-label="Day to deliver"
                    value={deferTo[p.id] ?? days[0]!.value}
                    onChange={(e) => setDeferTo((d) => ({ ...d, [p.id]: e.target.value }))}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1"
                  >
                    {days.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void post(p.id, 'ndr', { action: 'DEFER_DELIVERY', deferTo: deferTo[p.id] ?? days[0]!.value }, 'Asked Delhivery to deliver on that day.')
                    }
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-semibold disabled:opacity-50"
                  >
                    Deliver that day
                  </button>
                </div>
              )}
            </>
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
                  Good — put stock back
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void post(p.id, 'rto-received', { condition: 'DAMAGED' }, 'Reported damaged: our team will look at it.')}
                  className="rounded-lg border border-red-300 bg-white px-3 py-1.5 font-semibold text-red-600 disabled:opacity-50"
                >
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
