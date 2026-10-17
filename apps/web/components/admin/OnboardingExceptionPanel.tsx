'use client';

import { useState } from 'react';
import type { OnboardingExceptionView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import Spinner from '@/components/Spinner';

/**
 * An admin's onboarding exception for one seller: their approved listings may
 * be live before the business address or KYC is complete — until the store
 * opens for orders, or the optional end date. Payouts never: they still wait
 * for a verified PAN, GSTIN and bank account.
 */
export default function OnboardingExceptionPanel({
  sellerId,
  view,
  onChanged,
}: {
  sellerId: string;
  view: OnboardingExceptionView;
  onChanged: () => Promise<void> | void;
}) {
  const [reason, setReason] = useState(view.reason ?? '');
  const [until, setUntil] = useState(view.until ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/admin/sellers/${sellerId}/onboarding-exception`, {
        method: 'PUT',
        auth: true,
        body: { enabled, reason: reason.trim() || undefined, until: until || undefined },
        success: enabled ? 'Onboarding exception set' : 'Onboarding exception ended',
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900" data-onboarding-exception={view.enabled ? (view.active ? 'active' : 'inactive') : 'off'}>
      <p className="font-semibold">
        Onboarding exception: {view.enabled ? (view.active ? 'on' : 'on, but not holding (the store is open or the end date passed)') : 'off'}
      </p>
      <p className="mt-0.5 text-[11px]">
        Lets approved listings be live before the business address or KYC is complete — until the store opens for orders
        {view.until ? ` or ${view.until}` : ''}. Customer care then shows Clowe&apos;s contact. Payouts still wait for a verified PAN, GSTIN and bank account.
      </p>
      {view.enabled && view.reason && <p className="mt-1">Reason: {view.reason}</p>}
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (e.g. known to the owner, onboarding before launch)"
          className="rounded border border-sky-200 bg-white px-2 py-1"
          name="exceptionReason"
        />
        <label className="flex items-center gap-1">
          Ends (optional)
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="rounded border border-sky-200 bg-white px-1.5 py-0.5" name="exceptionUntil" />
        </label>
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void save(true)} className="rounded bg-sky-700 px-3 py-1 font-semibold text-white disabled:opacity-50" data-action="set-exception">
          {busy && <Spinner className="mr-1" />}
          {view.enabled ? 'Update exception' : 'Set exception'}
        </button>
        {view.enabled && (
          <button type="button" disabled={busy} onClick={() => void save(false)} className="rounded border border-sky-300 px-3 py-1 font-semibold disabled:opacity-50">
            End exception
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-red-700">{error}</p>}
    </section>
  );
}
