'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  KYC_CHECK_LABELS,
  KYC_CHECK_STATE_LABELS,
  KYC_REASON_LABELS,
  NAME_MATCH_BAND_LABELS,
  BANK_ACCOUNT_TYPE_LABELS,
  GST_PUBLIC_SEARCH_URL,
  type AdminKycReviewView,
  type BankAccountType,
  type KycCheckState,
  type KycCheckView,
  type SellerDocumentKind,
  type SellerKycSummary,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { ExternalLink } from '@/components/ExternalLink';

const STATE_STYLES: Record<KycCheckState, string> = {
  VERIFIED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
  ERROR: 'bg-amber-100 text-amber-800',
  NOT_PROVIDED: 'bg-gray-100 text-gray-500',
  INVALID_FORMAT: 'bg-red-100 text-red-700',
  NOT_RUN: 'bg-yellow-100 text-yellow-700',
  PENDING_REVIEW: 'bg-yellow-100 text-yellow-700',
  REJECTED: 'bg-red-100 text-red-700',
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
  if (view.check === 'GSTIN' || view.providerCheck?.outcome !== 'VERIFIED') return null;
  if (view.nameScore === null || view.nameBand === null) {
    return <p className="mt-0.5 text-amber-700">Holder name not checked</p>;
  }
  return (
    <p className={`mt-0.5 ${view.nameMeetsThreshold ? 'text-green-700' : 'font-semibold text-red-700'}`} data-kyc-name-match>
      Name match {view.nameScore} · {NAME_MATCH_BAND_LABELS[view.nameBand]}
      {!view.nameMeetsThreshold && <> — below {threshold}</>}
    </p>
  );
}

const OUTCOME_LABELS = { VERIFIED: 'verified', FAILED: 'not verified', ERROR: 'no answer' } as const;

/** What the verification provider said about this document: evidence, not the decision. */
function ProviderEvidence({ view }: { view: KycCheckView }) {
  const ev = view.providerCheck;
  if (!ev) return null;
  const tone = ev.outcome === 'VERIFIED' ? 'text-green-700' : ev.outcome === 'FAILED' ? 'text-red-700' : 'text-amber-700';
  return (
    <p className={`mt-0.5 text-[11px] ${tone}`} data-kyc-provider={ev.outcome}>
      Cashfree: {OUTCOME_LABELS[ev.outcome]} · {when(ev.checkedAt)}
      {ev.referenceId && <span className="text-gray-400"> · ref {ev.referenceId}</span>}
    </p>
  );
}

/**
 * Open a seller's private document: a fresh signed link, made by the API so
 * every opening is audit-logged. The tab opens first (a click's own popup is
 * never blocked), then goes to the document.
 */
export async function openSellerDocument(path: string): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const { url } = await api<{ url: string }>(path, { method: 'POST', auth: true });
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/**
 * KYC review: PAN, GSTIN and bank account, each with the values as entered
 * beside the documents, and Mark verified / Reject. With Cashfree connected,
 * "Verify with Cashfree" runs one (billed) check per press and shows its
 * answer; Mark verified opens only once that document passed. Every decision
 * is recorded with who made it and when. Until then the seller sees
 * "Pending review" — a mock check never verifies.
 */
export default function SellerKycPanel({ sellerId, onChanged }: { sellerId: string; onChanged: () => Promise<void> | void }) {
  const [review, setReview] = useState<AdminKycReviewView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setReview(await api<AdminKycReviewView>(`/api/admin/sellers/${sellerId}/kyc-review`, { auth: true }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load the KYC review');
    }
  }, [sellerId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function decide(check: KycCheckView['check'], decision: 'VERIFY' | 'REJECT') {
    let reason: string | undefined;
    if (decision === 'REJECT') {
      reason = window.prompt(`Why is the ${KYC_CHECK_LABELS[check]} rejected? (the seller sees this)`) ?? undefined;
      if (reason === undefined) return;
    } else if (!window.confirm(`Mark the ${KYC_CHECK_LABELS[check]} verified? Check it against the document first.`)) {
      return;
    }
    setBusy(`${check}:${decision}`);
    setError('');
    setNotice('');
    try {
      await api(`/api/admin/sellers/${sellerId}/kyc-review`, {
        method: 'POST',
        auth: true,
        body: { check, decision, reason },
        success: decision === 'VERIFY' ? `${KYC_CHECK_LABELS[check]} verified` : `${KYC_CHECK_LABELS[check]} rejected — the seller has been told why`,
      });
      await load();
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the decision');
    } finally {
      setBusy(null);
    }
  }

  async function verifyWithProvider(check: KycCheckView['check']) {
    if (!window.confirm(`Verify the ${KYC_CHECK_LABELS[check]} with Cashfree? This uses one Secure ID credit (a stored answer for the same details is reused for free).`)) {
      return;
    }
    setBusy(`${check}:RUN`);
    setError('');
    try {
      const res = await api<{ called: boolean; kyc: SellerKycSummary }>(`/api/admin/sellers/${sellerId}/kyc-checks`, { method: 'POST', body: { check }, auth: true });
      const after = check === 'PAN' ? res.kyc.pan : check === 'GSTIN' ? res.kyc.gstin : res.kyc.bank;
      setNotice(
        res.called
          ? `${KYC_CHECK_LABELS[check]} checked with Cashfree`
          : after.providerCheck
            ? `${KYC_CHECK_LABELS[check]}: Cashfree's stored answer for these details — no new check made`
            : `${KYC_CHECK_LABELS[check]}: nothing was sent — ${after.verifyBlockedReason ?? 'there is nothing to check'}`,
      );
      await load();
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not run the check');
    } finally {
      setBusy(null);
    }
  }

  async function open(kind: SellerDocumentKind) {
    setError('');
    try {
      await openSellerDocument(`/api/admin/sellers/${sellerId}/documents/${kind}/view`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not open the document');
    }
  }

  if (!review) {
    return <section className="mt-3 rounded-xl border border-gray-100 p-3 text-xs text-gray-500">{error || 'Loading KYC review…'}</section>;
  }
  const { summary: kyc, values: v } = review;
  const checks = [kyc.pan, kyc.gstin, kyc.bank];
  const entered: Record<KycCheckView['check'], { label: string; value: string }[]> = {
    PAN: [
      { label: 'PAN', value: v.pan ?? '—' },
      { label: 'Name on PAN', value: v.panName ?? '—' },
    ],
    GSTIN: [{ label: 'GSTIN', value: v.gstin ?? '—' }],
    BANK: [
      { label: 'Account holder', value: v.bankAccountName ?? '—' },
      { label: 'Account number', value: v.bankAccountNumber ?? '—' },
      { label: 'IFSC', value: v.bankIfsc ?? '—' },
      { label: 'Type', value: v.bankAccountType ? (BANK_ACCOUNT_TYPE_LABELS[v.bankAccountType as BankAccountType] ?? v.bankAccountType) : '—' },
      { label: 'Bank', value: v.bankName ?? '—' },
    ],
  };
  const hasValue = (view: KycCheckView) => view.state !== 'NOT_PROVIDED' && view.state !== 'INVALID_FORMAT';
  const hasSignatory = review.documents.some((d) => d.kind === 'signatoryKycDoc');

  return (
    <section className="mt-3 rounded-xl border border-gray-100 p-3" data-kyc-review>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-gray-500">KYC review</p>
        <p className="text-[11px] text-gray-400">
          {kyc.reviewMode === 'MANUAL'
            ? 'Manual review — no verification provider is connected'
            : `Cashfree checks, then your decision · name match threshold ${kyc.nameMatchThreshold}`}
        </p>
      </div>
      {error && <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{error}</p>}
      {notice && <p className="mt-2 rounded-lg bg-green-50 px-2.5 py-1.5 text-[11px] text-green-700" data-kyc-notice>{notice}</p>}

      <ul className="mt-2 divide-y divide-gray-50 text-xs">
        {checks.map((view) => (
          <li key={view.check} className="py-2.5" data-kyc-check={view.check}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-ink-900">{KYC_CHECK_LABELS[view.check]}</p>
                <dl className="mt-1 space-y-0.5 text-[11px]">
                  {entered[view.check].map((e) => (
                    <div key={e.label} className="flex gap-2">
                      <dt className="w-28 shrink-0 text-gray-500">{e.label}</dt>
                      <dd className="min-w-0 break-all font-mono text-ink-900">{e.value}</dd>
                    </div>
                  ))}
                </dl>
                {view.check === 'GSTIN' && v.gstin && (
                  <ExternalLink href={GST_PUBLIC_SEARCH_URL} className="mt-1 inline-block text-[11px] font-semibold text-brand-600 underline">
                    Check {v.gstin} on the GST portal ↗
                  </ExternalLink>
                )}
                <ProviderEvidence view={view} />
                {view.reason && (
                  <p className={view.providerCheck?.outcome === 'ERROR' || view.state === 'ERROR' ? 'mt-0.5 text-amber-700' : 'mt-0.5 text-red-700'}>{KYC_REASON_LABELS[view.reason]}</p>
                )}
                {view.rejectReason && <p className="mt-0.5 text-red-700">Rejected: {view.rejectReason}</p>}
                <NameMatch view={view} threshold={kyc.nameMatchThreshold} />
                {hasValue(view) && view.state !== 'VERIFIED' && !view.canMarkVerified && view.verifyBlockedReason && (
                  <p className="mt-0.5 text-[11px] text-gray-500" data-kyc-blocked>{view.verifyBlockedReason}</p>
                )}
                {view.checkedAt && (view.state === 'VERIFIED' || view.state === 'REJECTED' || view.state === 'FAILED') && (
                  <p className="mt-0.5 text-[11px] text-gray-400" data-kyc-decided>
                    {view.method === 'MANUAL' ? `By hand · ${view.decidedBy ?? 'an admin'}` : `By ${view.provider}`} · {when(view.checkedAt)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATE_STYLES[view.state]}`}>
                  {KYC_CHECK_STATE_LABELS[view.state]}
                </span>
                {hasValue(view) && view.state !== 'VERIFIED' && (
                  <button
                    onClick={() => void decide(view.check, 'VERIFY')}
                    disabled={busy !== null || !view.canMarkVerified}
                    title={view.canMarkVerified ? undefined : (view.verifyBlockedReason ?? undefined)}
                    data-kyc-verify={view.check}
                    className="rounded-lg bg-green-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {busy === `${view.check}:VERIFY` && <Spinner className="mr-1" />}
                    Mark verified
                  </button>
                )}
                {hasValue(view) && (
                  <button
                    onClick={() => void decide(view.check, 'REJECT')}
                    disabled={busy !== null}
                    data-kyc-reject={view.check}
                    className="rounded-lg border border-red-300 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    Reject…
                  </button>
                )}
                {kyc.reviewMode === 'PROVIDER' &&
                  hasValue(view) &&
                  view.state !== 'VERIFIED' &&
                  view.reason !== 'NAME_MISSING' &&
                  (!view.providerCheck ||
                    view.providerCheck.outcome === 'ERROR' ||
                    (view.check === 'BANK' && view.providerCheck.outcome === 'VERIFIED' && view.providerCheck.nameScore === null)) && (
                    <button
                      onClick={() => void verifyWithProvider(view.check)}
                      disabled={busy !== null}
                      data-kyc-provider-run={view.check}
                      className="rounded-lg border border-gray-300 px-2 py-0.5 text-[11px] font-semibold hover:bg-gray-50 disabled:opacity-50"
                    >
                      {busy === `${view.check}:RUN` ? 'Checking…' : view.providerCheck ? 'Check with Cashfree again' : 'Verify with Cashfree'}
                    </button>
                  )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-2 border-t border-gray-100 pt-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Documents</p>
        {review.documents.length === 0 ? (
          <p className="mt-1 text-[11px] text-gray-400">No documents on file.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-[11px]">
            {review.documents.map((d) => (
              <li key={d.kind} className="flex items-center justify-between gap-2">
                <span>{d.label}</span>
                <button type="button" onClick={() => void open(d.kind)} data-open-document={d.kind} className="font-semibold text-brand-600 underline">
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasSignatory && (
          <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800" data-aadhaar-warning>
            ⚠ If the signatory KYC is an Aadhaar card, check that it is the <strong>masked Aadhaar</strong> — only the last 4
            digits visible. A full Aadhaar number must not be kept: ask the seller for the masked copy from UIDAI instead.
          </p>
        )}
        <p className="mt-2 text-[11px] text-gray-400">Every document you open is recorded in the audit log.</p>
      </div>
    </section>
  );
}
