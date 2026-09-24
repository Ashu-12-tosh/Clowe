'use client';

import { useState } from 'react';
import {
  KYC_CHECK_LABELS,
  KYC_CHECK_STATE_LABELS,
  KYC_REASON_LABELS,
  NAME_MATCH_BAND_LABELS,
  type KycCheckState,
  type KycCheckView,
  type SellerKycSummary,
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

/**
 * The fraud signals, above everything else on the seller. Shown on every tab:
 * an admin who never opens the KYC section must still not miss them.
 */
export function KycFraudBanner({ kyc }: { kyc: SellerKycSummary }) {
  if (!kyc.panGstinMismatch && !kyc.fraudAccount) return null;
  return (
    <div className="mt-3 space-y-2 rounded-lg border-2 border-red-500 bg-red-50 px-3 py-2.5 text-xs text-red-800">
      {kyc.panGstinMismatch && (
        <p>
          <span className="font-bold">⚠ PAN–GSTIN mismatch.</span> The GSTIN is registered to PAN{' '}
          <span className="font-mono font-semibold">{kyc.panInGstin}</span>, but the PAN on file is{' '}
          <span className="font-mono font-semibold">{kyc.panOnFile}</span>. A strong fraud signal —
          the GSTIN may belong to someone else.
        </p>
      )}
      {kyc.fraudAccount && (
        <p>
          <span className="font-bold">⚠ Fraud-flagged bank account.</span> The verification provider
          flagged this seller&apos;s bank account as fraudulent.
        </p>
      )}
    </div>
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function NameMatch({ view, threshold }: { view: KycCheckView; threshold: number }) {
  if (view.check === 'GSTIN' || view.state !== 'VERIFIED') return null;
  if (view.nameScore === null || view.nameBand === null) {
    return <p className="mt-0.5 text-amber-700">Holder name not checked</p>;
  }
  return (
    <p className={`mt-0.5 ${view.nameMeetsThreshold ? 'text-green-700' : 'font-semibold text-red-700'}`}>
      Name match {view.nameScore} · {NAME_MATCH_BAND_LABELS[view.nameBand]}
      {!view.nameMeetsThreshold && <> — below {threshold}</>}
    </p>
  );
}

/**
 * Each automated check with its status, name-match score and band, provider
 * and time — what the admin needs in front of them before approving.
 */
export default function SellerKycPanel({
  sellerId,
  kyc,
  subjects,
  onChanged,
}: {
  sellerId: string;
  kyc: SellerKycSummary;
  /** What each check is about, so the admin can compare it with the result. */
  subjects: Record<KycCheckView['check'], string | null>;
  onChanged: () => Promise<void> | void;
}) {
  const [running, setRunning] = useState<KycCheckView['check'] | null>(null);
  const [error, setError] = useState('');
  const checks = [kyc.pan, kyc.gstin, kyc.bank];
  const onMock = checks.some((c) => c.provider === 'mock');

  async function rerun(check: KycCheckView['check']) {
    setRunning(check);
    setError('');
    try {
      await api(`/api/admin/sellers/${sellerId}/kyc-checks`, {
        method: 'POST',
        body: { check },
        auth: true,
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not run the check');
    } finally {
      setRunning(null);
    }
  }

  return (
    <section className="mt-3 rounded-xl border border-gray-100 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-gray-500">Verification checks</p>
        <p className="text-[11px] text-gray-400">Name match threshold: {kyc.nameMatchThreshold}</p>
      </div>

      {onMock && (
        <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          Checked by the mock provider — these are not real verifications.
        </p>
      )}
      {error && <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{error}</p>}

      <ul className="mt-2 divide-y divide-gray-50 text-xs">
        {checks.map((view) => {
          // A re-run only asks the provider about checks without an answer;
          // offer it where it can do something.
          const canRun =
            view.state === 'ERROR' || (view.state === 'NOT_RUN' && view.reason !== 'NAME_MISSING');
          return (
            <li key={view.check} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="font-semibold text-ink-900">{KYC_CHECK_LABELS[view.check]}</p>
                {subjects[view.check] && (
                  <p className="truncate text-[11px] text-gray-500">{subjects[view.check]}</p>
                )}
                {view.reason && (
                  <p className={view.state === 'ERROR' ? 'mt-0.5 text-amber-700' : 'mt-0.5 text-red-700'}>
                    {KYC_REASON_LABELS[view.reason]}
                  </p>
                )}
                <NameMatch view={view} threshold={kyc.nameMatchThreshold} />
                {view.checkedAt && (
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    {view.provider} · {when(view.checkedAt)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATE_STYLES[view.state]}`}>
                  {KYC_CHECK_STATE_LABELS[view.state]}
                </span>
                {canRun && (
                  <button
                    onClick={() => void rerun(view.check)}
                    disabled={running !== null}
                    className="rounded-lg border border-gray-300 px-2 py-0.5 text-[11px] font-semibold hover:bg-gray-50 disabled:opacity-50"
                  >
                    {running === view.check ? 'Checking…' : view.state === 'ERROR' ? 'Retry' : 'Run check'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[11px] text-gray-400">
        Each check is a paid call. Passed checks are never re-run; the bank account is checked again
        only when it changes.
      </p>
    </section>
  );
}
