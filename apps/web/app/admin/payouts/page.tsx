'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PAYOUT_STATUS_LABELS, payoutRejectSchema, type AdminPayoutRow, type PayoutStatusValue } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { formatPaise } from '@/lib/format';
import { PayoutStatusPill } from '@/components/seller/payouts/PayoutModals';

const CARD = 'rounded-2xl border border-gray-100 bg-white p-4';
const TABS: PayoutStatusValue[] = ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'REVERSED'];

interface Listing {
  rows: AdminPayoutRow[];
  counts: Record<PayoutStatusValue, number>;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/**
 * Payout approvals. Every payout a seller requests waits here until an admin
 * approves it (it is sent at once, through Cashfree Payouts) or rejects it
 * with a reason (the amount goes back to the seller's balance). Both are in
 * the audit log. Sending without approval is a setting, off until payouts
 * have run unattended for a while.
 */
export default function AdminPayoutsPage() {
  const [tab, setTab] = useState<PayoutStatusValue>('PENDING');
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');

  const load = useCallback(() => {
    setData(null);
    setError('');
    api<Listing>(`/api/admin/payouts?status=${tab}`, { auth: true })
      .then(setData)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load'));
  }, [tab]);
  useEffect(load, [load]);

  async function approve(row: AdminPayoutRow) {
    if (busy) return;
    if (!window.confirm(`Send ${formatPaise(row.netPaise)} to ${row.shopName} (${row.methodLabel ?? 'their bank'}) now? This moves real money.`)) return;
    setBusy(`approve:${row.id}`);
    try {
      const after = await api<AdminPayoutRow>(`/api/admin/payouts/${row.id}/approve`, {
        method: 'POST',
        auth: true,
        success: `${row.reference} approved`,
      });
      if (after.status === 'FAILED') setError(`${row.reference} could not be sent: ${after.failureReason ?? 'transfer failed'}`);
      load();
    } catch {
      // Reported by the API client.
    } finally {
      setBusy(null);
    }
  }

  async function reject(row: AdminPayoutRow) {
    if (busy) return;
    const checked = payoutRejectSchema.safeParse({ reason });
    if (!checked.success) {
      setReasonError(checked.error.issues[0]!.message);
      return;
    }
    setBusy(`reject:${row.id}`);
    try {
      await api(`/api/admin/payouts/${row.id}/reject`, {
        method: 'POST',
        body: checked.data,
        auth: true,
        success: `${row.reference} rejected — ${row.shopName} has been told`,
      });
      setRejecting(null);
      setReason('');
      setReasonError('');
      load();
    } catch {
      // Reported by the API client.
    } finally {
      setBusy(null);
    }
  }

  async function check(row: AdminPayoutRow) {
    if (busy) return;
    setBusy(`check:${row.id}`);
    try {
      await api(`/api/admin/payouts/${row.id}/check`, { method: 'POST', auth: true, success: 'Status checked' });
      load();
    } catch {
      // Reported by the API client.
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Payout approvals</h1>
        <p className="mt-1 text-sm text-gray-500">
          Every payout a seller requests waits here. Approve to send it now through Cashfree Payouts, or reject it with
          a reason — the amount goes back to the seller&apos;s balance. Both are recorded in the{' '}
          <Link href="/admin/audit" className="underline">
            audit log
          </Link>
          .
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide ${
              tab === t ? 'bg-ink-900 text-white' : 'border border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            {PAYOUT_STATUS_LABELS[t]}
            {data?.counts[t] ? ` · ${data.counts[t]}` : ''}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!data && !error && <Spinner />}
      {data && data.rows.length === 0 && (
        <p className={`${CARD} text-sm text-gray-500`}>{tab === 'PENDING' ? 'Nothing waiting for approval.' : 'None.'}</p>
      )}

      {data?.rows.map((row) => (
        <section key={row.id} className={CARD} data-payout={row.reference}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-ink-900">
                {formatPaise(row.netPaise)} · {row.shopName}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {row.reference} · {row.itemCount} item{row.itemCount === 1 ? '' : 's'} · to {row.methodLabel ?? '—'} · requested{' '}
                {when(row.requestedAt)}
              </p>
            </div>
            <PayoutStatusPill status={row.status} />
          </div>

          <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
            <div>
              <dt className="text-gray-500">Gross sales</dt>
              <dd className="font-semibold text-ink-900">{formatPaise(row.grossPaise)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Clowe fees</dt>
              <dd className="font-semibold text-ink-900">− {formatPaise(row.feesPaise)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">TDS + TCS</dt>
              <dd className="font-semibold text-ink-900">− {formatPaise(row.tdsPaise + row.tcsPaise)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Recovered</dt>
              <dd className="font-semibold text-ink-900">− {formatPaise(row.adjustmentPaise)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">To send</dt>
              <dd className="font-bold text-ink-900">{formatPaise(row.netPaise)}</dd>
            </div>
          </dl>

          {(row.reviewedBy || row.utr || row.failureReason || row.rejectionReason || row.providerStatus) && (
            <p className="mt-2 text-xs text-gray-600">
              {row.reviewedBy && <>Reviewed by {row.reviewedBy}, {when(row.reviewedAt)}. </>}
              {row.utr && (
                <>
                  UTR <span className="font-mono">{row.utr}</span>.{' '}
                </>
              )}
              {row.providerStatus && <>Cashfree: {row.providerStatus}. </>}
              {row.rejectionReason && <span className="text-gray-700">Rejected: {row.rejectionReason}. </span>}
              {row.failureReason && !row.rejectionReason && <span className="text-red-600">{row.failureReason}</span>}
            </p>
          )}

          {row.status === 'PENDING' && (
            <div className="mt-3 space-y-2">
              {rejecting === row.id ? (
                <div className="flex flex-wrap items-start gap-2">
                  <label className="min-w-[16rem] flex-1 text-xs font-semibold text-gray-700">
                    Why it is not approved (the seller sees this)
                    <input
                      name="reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal outline-none focus:border-brand-600"
                    />
                    {reasonError && <span className="mt-1 block text-red-600">{reasonError}</span>}
                  </label>
                  <button
                    onClick={() => void reject(row)}
                    disabled={busy !== null}
                    className="mt-5 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {busy === `reject:${row.id}` ? 'Saving…' : 'Reject payout'}
                  </button>
                  <button
                    onClick={() => {
                      setRejecting(null);
                      setReasonError('');
                    }}
                    className="mt-5 rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void approve(row)}
                    disabled={busy !== null}
                    className="rounded-lg bg-green-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {busy === `approve:${row.id}` ? 'Sending…' : 'Approve & send'}
                  </button>
                  <button
                    onClick={() => {
                      setRejecting(row.id);
                      setReason('');
                    }}
                    disabled={busy !== null}
                    className="rounded-lg border border-red-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <Link
                    href="/admin/sellers"
                    className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-gray-700 hover:border-gray-400"
                  >
                    Seller &amp; KYC
                  </Link>
                </div>
              )}
            </div>
          )}

          {row.status === 'PROCESSING' && (
            <button
              onClick={() => void check(row)}
              disabled={busy !== null}
              className="mt-3 rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-gray-700 hover:border-gray-400 disabled:opacity-50"
            >
              {busy === `check:${row.id}` ? 'Checking…' : 'Check with Cashfree'}
            </button>
          )}
        </section>
      ))}
    </div>
  );
}
