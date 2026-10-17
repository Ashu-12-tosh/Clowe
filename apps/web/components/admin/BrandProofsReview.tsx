'use client';

import { useCallback, useEffect, useState } from 'react';
import { BRAND_AUTH_LABELS, BRAND_PROOF_TYPE_LABELS, type AdminBrandProofRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { openSellerDocument } from './SellerKycPanel';

/**
 * Sellers' brand proofs (authorization letter or GST purchase invoice) for
 * brands marked "authorization required". An approval covers that seller's
 * listings of the brand, until the optional expiry date.
 */
export default function BrandProofsReview() {
  const [scope, setScope] = useState<'PENDING' | 'ALL'>('PENDING');
  const [rows, setRows] = useState<AdminBrandProofRow[] | null>(null);
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setRows(null);
    api<AdminBrandProofRow[]>(`/api/admin/brand-proofs?status=${scope}`, { auth: true })
      .then(setRows)
      .catch((err) => {
        setRows([]);
        setError(err instanceof ApiRequestError ? err.message : 'Could not load brand proofs');
      });
  }, [scope]);
  useEffect(load, [load]);

  async function decide(row: AdminBrandProofRow, decision: 'APPROVE' | 'REJECT') {
    let note: string | undefined;
    if (decision === 'REJECT') {
      note = window.prompt(`Why is ${row.shopName}'s ${row.brandName} proof not accepted? (the seller sees this)`) ?? undefined;
      if (note === undefined) return;
    }
    setBusy(row.id);
    setError('');
    try {
      await api(`/api/admin/brand-proofs/${row.id}`, {
        method: 'POST',
        auth: true,
        body: { decision, note, ...(decision === 'APPROVE' && expiry[row.id] ? { expiresAt: expiry[row.id] } : {}) },
        success: decision === 'APPROVE' ? `${row.brandName} approved for ${row.shopName}` : `${row.brandName} proof rejected — the seller has been told why`,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the decision');
    } finally {
      setBusy(null);
    }
  }

  async function open(row: AdminBrandProofRow) {
    setError('');
    try {
      await openSellerDocument(`/api/admin/brand-proofs/${row.id}/view`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not open the document');
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-gray-100 bg-white p-4" data-brand-proofs>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">Brand proofs</h2>
          <p className="text-xs text-gray-500">
            Authorization letters or GST purchase invoices for brands that need them. An approval covers that seller&apos;s listings of the brand until its expiry date (optional).
          </p>
        </div>
        <div className="flex gap-1">
          {(['PENDING', 'ALL'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${scope === s ? 'bg-ink-900 text-white' : 'bg-gray-100 text-gray-600'}`}
            >
              {s === 'PENDING' ? 'To review' : 'All'}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {rows === null && <p className="mt-3 text-xs text-gray-500">Loading…</p>}
      {rows?.length === 0 && <p className="mt-3 text-xs text-gray-500">{scope === 'PENDING' ? 'Nothing waiting for review.' : 'No brand proofs yet.'}</p>}
      <ul className="mt-3 divide-y divide-gray-100">
        {rows?.map((row) => (
          <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-xs" data-brand-proof={row.status}>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-900">
                {row.brandName} · <span className="font-normal">{row.shopName}</span>
              </p>
              <p className="text-gray-500">
                {BRAND_PROOF_TYPE_LABELS[row.proofType]} · sent {new Date(row.submittedAt).toLocaleString('en-IN')} · {row.listingCount} listing
                {row.listingCount === 1 ? '' : 's'} of this brand
              </p>
              <p className={row.status === 'APPROVED' ? 'text-green-700' : row.status === 'PENDING' ? 'text-amber-700' : 'text-red-600'}>
                {BRAND_AUTH_LABELS[row.status]}
                {row.expiresAt && ` · until ${row.expiresAt}`}
                {row.note && ` · ${row.note}`}
              </p>
              <button type="button" onClick={() => void open(row)} className="mt-1 font-semibold text-brand-600 underline">
                Open the document
              </button>
            </div>
            {row.status === 'PENDING' && (
              <div className="flex flex-col items-end gap-1.5">
                <label className="text-[11px] text-gray-500">
                  Valid until (optional){' '}
                  <input
                    type="date"
                    value={expiry[row.id] ?? ''}
                    onChange={(e) => setExpiry((x) => ({ ...x, [row.id]: e.target.value }))}
                    className="rounded border border-gray-200 px-1.5 py-0.5"
                  />
                </label>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void decide(row, 'APPROVE')}
                    disabled={busy !== null}
                    data-action="approve-brand-proof"
                    className="rounded-lg bg-green-600 px-3 py-1.5 font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {busy === row.id && <Spinner className="mr-1" />}Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide(row, 'REJECT')}
                    disabled={busy !== null}
                    data-action="reject-brand-proof"
                    className="rounded-lg border border-red-300 px-3 py-1.5 font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    Reject…
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
