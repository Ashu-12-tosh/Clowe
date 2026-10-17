'use client';

import { useState } from 'react';
import { MAX_DELIVERY_ATTEMPTS, type ParcelNdrInput } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import Spinner from '@/components/Spinner';

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

const ACTION_DONE: Record<string, string> = {
  RE_ATTEMPT: 'try again',
  DEFER_DELIVERY: 'deliver on another day',
  EDIT_DETAILS: 'deliver to the corrected details',
  RETURN_TO_SELLER: 'bring it back to the seller',
};

/**
 * After a failed delivery attempt (NDR): Delhivery's reason and the attempt
 * count, then what to ask of Delhivery — try again, another day, a corrected
 * address within the same PIN code (and phone, for admins: sellers never see
 * it), or a return to the seller. Used by the seller's order page and the
 * admin shipments desk; `path` is the parcel's NDR endpoint for each.
 */
export function NdrActions({
  path,
  awbNumber,
  reason,
  attempts,
  ndrAction,
  ndrActionAt,
  deliverTo,
  canEditPhone,
  onDone,
}: {
  path: string;
  awbNumber: string | null;
  reason: string | null;
  attempts: number;
  ndrAction: string | null;
  ndrActionAt: string | null;
  deliverTo: { line1: string; line2: string | null; city: string; pincode: string };
  canEditPhone: boolean;
  onDone: (message: string) => void;
}) {
  const days = nextDays();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [deferTo, setDeferTo] = useState(days[0]!.value);
  const [editing, setEditing] = useState(false);
  const [line1, setLine1] = useState(deliverTo.line1);
  const [line2, setLine2] = useState(deliverTo.line2 ?? '');
  const [phone, setPhone] = useState('');

  async function send(body: ParcelNdrInput, done: string) {
    if (busy) return;
    setBusy(body.action);
    setError('');
    try {
      await api(path, { method: 'POST', body, auth: true, success: done, quiet: true });
      setEditing(false);
      onDone(done);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Delhivery could not be asked just now — try again shortly.');
    } finally {
      setBusy(null);
    }
  }

  function saveDetails() {
    const changedAddress = line1.trim() !== deliverTo.line1 || line2.trim() !== (deliverTo.line2 ?? '');
    if (!changedAddress && !phone.trim()) {
      setError(canEditPhone ? 'Change the address or give a new phone first.' : 'Change the address first.');
      return;
    }
    void send(
      {
        action: 'EDIT_DETAILS',
        ...(changedAddress ? { line1: line1.trim(), line2: line2.trim() } : {}),
        ...(canEditPhone && phone.trim() ? { phone: phone.trim() } : {}),
      },
      'Asked Delhivery to deliver to the corrected details.',
    );
  }

  const lastAttempt = attempts >= MAX_DELIVERY_ATTEMPTS;
  return (
    <div className="text-xs" data-ndr>
      <p className="font-semibold text-ink-900">
        Delivery attempt failed — AWB {awbNumber ?? '—'} · attempt {Math.min(Math.max(attempts, 1), MAX_DELIVERY_ATTEMPTS)} of{' '}
        {MAX_DELIVERY_ATTEMPTS}
      </p>
      <p className="mt-0.5 text-gray-600">Delhivery says: {reason ?? 'it could not deliver the parcel.'}</p>
      {lastAttempt && <p className="mt-0.5 text-gray-600">That was the last attempt: unless you act now, it comes back to the seller.</p>}
      {ndrAction ? (
        <p className="mt-1 text-gray-600">
          Asked Delhivery to {ACTION_DONE[ndrAction] ?? ndrAction.toLowerCase()}
          {ndrActionAt ? ` on ${new Date(ndrActionAt).toLocaleDateString('en-IN')}` : ''}.
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void send({ action: 'RE_ATTEMPT' }, 'Asked Delhivery to try again.')}
              className="rounded-lg bg-ink-900 px-3 py-1.5 font-bold uppercase tracking-wide text-white disabled:opacity-50"
            >
              {busy === 'RE_ATTEMPT' && <Spinner className="mr-1" />}
              Try again
            </button>
            <span className="text-gray-500">or deliver on</span>
            <select
              aria-label="Day to deliver"
              value={deferTo}
              onChange={(e) => setDeferTo(e.target.value)}
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
              onClick={() => void send({ action: 'DEFER_DELIVERY', deferTo }, 'Asked Delhivery to deliver on that day.')}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-semibold disabled:opacity-50"
            >
              {busy === 'DEFER_DELIVERY' && <Spinner className="mr-1" />}
              Deliver that day
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setEditing((e) => !e)}
              aria-expanded={editing}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-semibold disabled:opacity-50"
            >
              {canEditPhone ? 'Correct address / phone' : 'Correct address'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm('Ask Delhivery to bring this parcel back to the seller? The buyer will not get it, and a prepaid buyer is refunded.')) {
                  void send({ action: 'RETURN_TO_SELLER' }, 'Asked Delhivery to bring it back to the seller.');
                }
              }}
              className="rounded-lg border border-red-300 bg-white px-3 py-1.5 font-semibold text-red-600 disabled:opacity-50"
            >
              {busy === 'RETURN_TO_SELLER' && <Spinner className="mr-1" />}
              Return to seller
            </button>
          </div>
          {editing && (
            <div className="mt-2 grid gap-2 rounded-lg border border-gray-200 bg-white p-2 sm:grid-cols-2" data-ndr-edit>
              <label className="sm:col-span-2">
                <span className="text-gray-500">Address (house, street)</span>
                <input name="ndrLine1" value={line1} onChange={(e) => setLine1(e.target.value)} className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1" />
              </label>
              <label className="sm:col-span-2">
                <span className="text-gray-500">Area, landmark</span>
                <input name="ndrLine2" value={line2} onChange={(e) => setLine2(e.target.value)} className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1" />
              </label>
              <p className="text-gray-500 sm:col-span-2">
                {deliverTo.city} — {deliverTo.pincode}. The PIN code stays the same: Delhivery only re-routes a parcel within it.
              </p>
              {canEditPhone && (
                <label>
                  <span className="text-gray-500">New phone (leave empty to keep it)</span>
                  <input
                    name="ndrPhone"
                    inputMode="numeric"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1"
                  />
                </label>
              )}
              <div className="flex items-end sm:col-span-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={saveDetails}
                  className="rounded-lg bg-ink-900 px-3 py-1.5 font-bold uppercase tracking-wide text-white disabled:opacity-50"
                >
                  {busy === 'EDIT_DETAILS' && <Spinner className="mr-1" />}
                  Ask Delhivery to deliver here
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <p className="mt-1 rounded bg-red-50 px-2 py-1 text-red-700">{error}</p>}
    </div>
  );
}
