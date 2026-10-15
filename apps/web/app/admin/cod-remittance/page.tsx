'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  COD_REMITTANCE_STATUS_LABELS,
  type CodRemittanceImportResult,
  type CodRemittanceOverview,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { toast } from '@/lib/toast';
import Spinner from '@/components/Spinner';
import { formatPaise } from '@/lib/format';

const CARD = 'rounded-2xl border border-gray-100 bg-white p-4';
const ROW_TONE: Record<string, string> = {
  MATCHED: 'text-green-700',
  MISMATCH: 'text-red-600',
  UNKNOWN: 'text-amber-700',
  DUPLICATE: 'text-gray-500',
};

/**
 * COD remittance: the cash Delhivery collected on delivered COD parcels and
 * hasn't yet paid Clowe, and its remittance reports matched to those parcels.
 * Sellers are paid for a COD line only once its parcel's remittance matches.
 */
export default function CodRemittancePage() {
  const [overview, setOverview] = useState<CodRemittanceOverview | null>(null);
  const [result, setResult] = useState<CodRemittanceImportResult | null>(null);
  // 'import', or the parcel being marked.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<CodRemittanceOverview>('/api/admin/cod-remittances', { auth: true })
      .then(setOverview)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load'));
  }, []);
  useEffect(load, [load]);

  async function upload(file: File) {
    if (busy) return;
    setBusy('import');
    setError('');
    try {
      const csv = await file.text();
      const imported = await api<CodRemittanceImportResult>('/api/admin/cod-remittances/import', {
        method: 'POST',
        body: { csv, fileName: file.name },
        auth: true,
      });
      setResult(imported);
      const problems = imported.mismatched + imported.unknown;
      (problems > 0 ? toast.error : toast.success)(
        `Report imported: ${imported.matched} matched` +
          (problems > 0 ? `, ${problems} need a look (below)` : '') +
          (imported.duplicate > 0 ? `, ${imported.duplicate} already imported` : ''),
      );
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Import failed');
    } finally {
      setBusy(null);
    }
  }

  async function mark(shipmentId: string) {
    const reference = window.prompt('Bank transaction reference (UTR) for this remittance');
    if (!reference || busy) return;
    setBusy(shipmentId);
    setError('');
    try {
      await api(`/api/admin/cod-remittances/parcels/${shipmentId}/mark`, {
        method: 'POST',
        body: { reference },
        auth: true,
        success: 'Marked remitted — the seller can now be paid for it',
      });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not mark it');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 pb-10">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">COD remittance</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Cash Delhivery collected on delivered COD parcels. Sellers are paid for a COD line once its parcel&apos;s
          remittance is matched here.
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <section className={CARD}>
        <h2 className="text-sm font-bold text-ink-900">Import a remittance report</h2>
        <p className="mt-1 text-xs text-gray-500">
          Delhivery One → Finances → Remittance → export as CSV. Rows are matched by AWB and COD amount; only an exact
          match releases the seller&apos;s money.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={!!busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
          className="mt-3 text-xs"
        />
        {busy === 'import' && (
          <p className="mt-2 text-xs text-gray-500" aria-live="polite">
            <Spinner className="mr-1" />
            Importing…
          </p>
        )}
        {result && (
          <div className="mt-3 text-xs" data-import-result>
            <p className="font-semibold text-ink-900">
              {result.matched} matched · {result.mismatched} amount differs · {result.unknown} not ours · {result.duplicate} already matched
            </p>
            <ul className="mt-2 max-h-64 divide-y divide-gray-50 overflow-y-auto">
              {result.rows.map((r, i) => (
                <li key={`${r.awbNumber}-${i}`} className="flex flex-wrap justify-between gap-2 py-1">
                  <span className="font-mono">{r.awbNumber}</span>
                  <span>{r.orderNumber ?? '—'}</span>
                  <span>{r.amountPaise === null ? '—' : formatPaise(r.amountPaise)}</span>
                  <span className={ROW_TONE[r.status]}>
                    {COD_REMITTANCE_STATUS_LABELS[r.status]}
                    {r.note ? ` (${r.note})` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold text-ink-900">Awaiting remittance</h2>
          {overview && <p className="text-sm font-bold text-ink-900">{formatPaise(overview.awaitingTotalPaise)}</p>}
        </div>
        {!overview && <div className="mt-3 h-16 animate-pulse rounded-xl bg-gray-100" />}
        {overview && overview.awaiting.length === 0 && <p className="mt-2 text-xs text-gray-400">Nothing outstanding.</p>}
        {overview && overview.awaiting.length > 0 && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-gray-400">
                <tr>
                  <th className="py-1.5 pr-3 font-semibold">Delivered</th>
                  <th className="py-1.5 pr-3 font-semibold">Order</th>
                  <th className="py-1.5 pr-3 font-semibold">AWB</th>
                  <th className="py-1.5 pr-3 font-semibold">Seller</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">COD</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {overview.awaiting.map((a) => (
                  <tr key={a.shipmentId}>
                    <td className="py-1.5 pr-3">{a.deliveredAt ? new Date(a.deliveredAt).toLocaleDateString('en-IN') : '—'}</td>
                    <td className="py-1.5 pr-3">{a.orderNumber}</td>
                    <td className="py-1.5 pr-3 font-mono">{a.awbNumber ?? '—'}</td>
                    <td className="py-1.5 pr-3">{a.shopName}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold">{formatPaise(a.codAmountPaise)}</td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        disabled={!!busy}
                        aria-busy={busy === a.shipmentId}
                        onClick={() => void mark(a.shipmentId)}
                        className="rounded-lg border border-gray-300 px-2 py-0.5 text-[11px] font-semibold hover:bg-gray-50 disabled:opacity-50"
                      >
                        {busy === a.shipmentId && <Spinner className="mr-1" />}
                        Mark remitted
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {overview && overview.imports.length > 0 && (
        <section className={CARD}>
          <h2 className="text-sm font-bold text-ink-900">Reports imported</h2>
          <ul className="mt-2 divide-y divide-gray-50 text-xs">
            {overview.imports.map((i) => (
              <li key={i.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span>{i.fileName ?? 'report'}</span>
                <span className="text-gray-500">{new Date(i.createdAt).toLocaleString('en-IN')}</span>
                <span>
                  {i.matched}/{i.rowCount} matched{i.mismatched ? ` · ${i.mismatched} differ` : ''}
                  {i.unknown ? ` · ${i.unknown} not ours` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
