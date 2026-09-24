'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  KYC_CHECK_LABELS,
  KYC_CHECK_STATE_LABELS,
  type KycCheckState,
  type SellerKycCheckView,
  type SellerKycStatus,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const STATE_STYLES: Record<KycCheckState, string> = {
  VERIFIED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
  ERROR: 'bg-amber-100 text-amber-800',
  NOT_PROVIDED: 'bg-gray-100 text-gray-500',
  INVALID_FORMAT: 'bg-red-100 text-red-700',
  NOT_RUN: 'bg-yellow-100 text-yellow-700',
};

/** What the seller can do about a check, in their terms. Never a score. */
function guidance(view: SellerKycCheckView): string | null {
  const label = KYC_CHECK_LABELS[view.check];
  switch (view.state) {
    case 'VERIFIED':
      return view.nameNeedsReview
        ? `The name did not closely match the ${label === 'PAN' ? 'PAN' : "bank's"} records. Our team will review it.`
        : null;
    case 'FAILED':
      return view.check === 'BANK'
        ? `${view.reasonLabel ?? 'Not verified'}. Contact support to change your bank account.`
        : `${view.reasonLabel ?? 'Not verified'}. Correct the number above and save to check it again.`;
    case 'ERROR':
      return `We could not finish this check (${view.reasonLabel ?? 'provider error'}). Try again later.`;
    case 'NOT_PROVIDED':
      return view.check === 'GSTIN'
        ? 'Optional — add it above if your business is GST-registered.'
        : view.check === 'PAN'
          ? 'Add your PAN above.'
          : 'No bank account on file. Contact support to add one.';
    case 'INVALID_FORMAT':
      return `This does not look like a valid ${label} — check it above.`;
    case 'NOT_RUN':
      return view.reasonLabel
        ? 'Add your name exactly as printed on your PAN card above, then save.'
        : 'Not verified yet.';
  }
}

/**
 * The seller's side of KYC: where each check stands and a way to run the
 * ones that are waiting. Each check is a paid call, so there is no automatic
 * retry here — the button is the retry, and the server rate-limits it.
 */
export default function KycVerificationCard({ refresh }: { refresh: unknown }) {
  const [status, setStatus] = useState<SellerKycStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await api<SellerKycStatus>('/api/seller/kyc', { auth: true }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load verification status');
    }
  }, []);

  // Saving the business details can change what there is to verify.
  useEffect(() => {
    void load();
  }, [load, refresh]);

  async function verify() {
    setBusy(true);
    setError('');
    try {
      setStatus(await api<SellerKycStatus>('/api/seller/kyc/verify', { method: 'POST', auth: true }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not run verification');
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return error ? <p className="text-xs text-red-600">{error}</p> : null;
  }

  const checks = [status.pan, status.gstin, status.bank];
  const hasError = checks.some((c) => c.state === 'ERROR');

  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-ink-900">Verification</h2>
          <p className="text-[11px] text-gray-400">
            We check your PAN, GSTIN and bank account with the issuing records.
          </p>
        </div>
        {status.canVerify && (
          <button
            onClick={() => void verify()}
            disabled={busy}
            className="shrink-0 rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
          >
            {busy ? 'Checking…' : hasError ? 'Try again' : 'Verify now'}
          </button>
        )}
      </div>

      {status.panGstinMismatch && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          Your GSTIN is registered to a different PAN from the one you entered (characters 3–12 of a
          GSTIN are the PAN). Check both numbers.
        </p>
      )}
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      <ul className="mt-3 divide-y divide-gray-50 text-xs">
        {checks.map((view) => {
          const hint = guidance(view);
          return (
            <li key={view.check} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="font-semibold text-ink-900">{KYC_CHECK_LABELS[view.check]}</p>
                {hint && <p className="mt-0.5 text-[11px] text-gray-500">{hint}</p>}
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATE_STYLES[view.state]}`}
              >
                {KYC_CHECK_STATE_LABELS[view.state]}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
