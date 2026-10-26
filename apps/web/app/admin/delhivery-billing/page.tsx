'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DELHIVERY_BILLING_FIELDS,
  DELHIVERY_BILLING_FIELD_LABELS,
  DELHIVERY_BILLING_STATUSES,
  DELHIVERY_BILLING_STATUS_LABELS,
  parseCsv,
  resolveBillingColumns,
  type DelhiveryBillingCheckListItem,
  type DelhiveryBillingCheckView,
  type DelhiveryBillingColumns,
  type DelhiveryBillingColumnsView,
  type DelhiveryBillingKind,
  type DelhiveryBillingLineRow,
  type DelhiveryBillingStatus,
  type DelhiveryBillingUploadResult,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { toast } from '@/lib/toast';
import Spinner from '@/components/Spinner';
import { formatPaise } from '@/lib/format';

const CARD = 'rounded-2xl border border-gray-100 bg-white p-4';
const SELECT = 'rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none';
const STATUS_TONE: Record<DelhiveryBillingStatus, string> = {
  MATCHED: 'text-green-700',
  MISMATCH: 'text-red-600',
  NOT_ON_LEDGER: 'text-amber-700',
  UNKNOWN_AWB: 'text-gray-500',
};
const KIND_LABEL: Record<DelhiveryBillingKind, string> = { FORWARD: 'Forward', RTO: 'RTO', DTO: 'Return pickup' };
/** The API takes JSON bodies up to 1 MB. */
const MAX_FILE_BYTES = 1_000_000;

const kg = (grams: number | null) => (grams === null ? '—' : `${grams / 1000} kg`);
const signed = (paise: number) => (paise > 0 ? `+${formatPaise(paise)}` : paise < 0 ? `−${formatPaise(-paise)}` : formatPaise(0));

/** Last month, by the Indian calendar: the bill that has usually just arrived. */
function lastMonth(): string {
  const [y, m] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** What the admin is agreeing to, in words, before anything is posted. */
function confirmText(l: DelhiveryBillingLineRow): string {
  const amount = formatPaise(Math.abs(l.differencePaise));
  const shop = l.shopName ?? 'the seller';
  const lines = [
    `Post a freight adjustment to ${shop}'s ledger?`,
    '',
    `AWB ${l.awbNumber} (${KIND_LABEL[l.kind]})${l.orderNumber ? `, order ${l.orderNumber}` : ''}`,
    `Delhivery billed ${formatPaise(l.billedPaise)}; the seller was charged ${l.ledgerPaise === null ? 'nothing yet' : formatPaise(l.ledgerPaise)}.`,
    '',
    l.differencePaise > 0 ? `This CHARGES ${shop} ${amount} more.` : `This CREDITS ${shop} ${amount} back.`,
  ];
  if (l.status === 'NOT_ON_LEDGER') {
    lines.push(
      '',
      'Nothing is on the ledger for this trip yet, so the seller is charged the whole billed amount. The trip then counts as charged: Clowe will not post its own freight for it again when the parcel is delivered or returned.',
    );
  }
  return lines.join('\n');
}

/**
 * Delhivery billing check: the month's billing export from Delhivery matched,
 * by AWB, to what each seller was charged for the same parcels — forward,
 * RTO and return pickup, and the charged weight. Nothing is posted by the
 * check; an admin confirms each adjustment.
 */
export default function DelhiveryBillingPage() {
  const [columnsView, setColumnsView] = useState<DelhiveryBillingColumnsView | null>(null);
  const [columns, setColumns] = useState<DelhiveryBillingColumns | null>(null);
  const [checks, setChecks] = useState<DelhiveryBillingCheckListItem[] | null>(null);
  const [check, setCheck] = useState<DelhiveryBillingCheckView | null>(null);
  const [skipped, setSkipped] = useState<DelhiveryBillingUploadResult['skipped']>([]);
  const [month, setMonth] = useState(lastMonth);
  const [file, setFile] = useState<{ name: string; text: string; headers: string[] } | null>(null);
  const [statusFilter, setStatusFilter] = useState<DelhiveryBillingStatus | ''>('');
  const [sellerFilter, setSellerFilter] = useState('');
  // 'upload', 'columns', 'open', or the line being adjusted.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadColumns = useCallback(() => {
    api<DelhiveryBillingColumnsView>('/api/admin/delhivery-billing/columns', { auth: true })
      .then((v) => {
        setColumnsView(v);
        setColumns(v.columns);
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load'));
  }, []);
  const loadChecks = useCallback(() => {
    api<DelhiveryBillingCheckListItem[]>('/api/admin/delhivery-billing/checks', { auth: true })
      .then(setChecks)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load'));
  }, []);
  useEffect(() => {
    loadColumns();
    loadChecks();
  }, [loadColumns, loadChecks]);

  const openCheck = useCallback(async (id: string) => {
    setBusy('open');
    setError('');
    try {
      setCheck(await api<DelhiveryBillingCheckView>(`/api/admin/delhivery-billing/checks/${id}`, { auth: true }));
      setSkipped([]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not open the check');
    } finally {
      setBusy(null);
    }
  }, []);

  async function chooseFile(f: File) {
    setError('');
    if (f.size > MAX_FILE_BYTES) {
      setFile(null);
      setError('The file is over 1 MB. Split it into parts (keep the header row in each) and check each part.');
      return;
    }
    const text = await f.text();
    const headers = (parseCsv(text.slice(0, 20_000))[0] ?? []).map((h) => h.trim()).filter(Boolean);
    setFile({ name: f.name, text, headers });
  }

  async function upload() {
    if (!file || busy) return;
    setBusy('upload');
    setError('');
    try {
      const result = await api<DelhiveryBillingUploadResult>('/api/admin/delhivery-billing/checks', {
        method: 'POST',
        body: { month, fileName: file.name, csv: file.text },
        auth: true,
      });
      const { skipped: rowsSkipped, ...view } = result;
      setCheck(view);
      setSkipped(rowsSkipped);
      setStatusFilter('');
      setSellerFilter('');
      const off = result.summary.counts.MISMATCH + result.summary.counts.NOT_ON_LEDGER + result.summary.counts.UNKNOWN_AWB;
      (off > 0 ? toast.error : toast.success)(
        `Checked ${result.lines.length} charges: ${result.summary.counts.MATCHED} match` + (off > 0 ? `, ${off} need a look (below)` : ''),
      );
      loadChecks();
      loadColumns();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed');
    } finally {
      setBusy(null);
    }
  }

  async function saveColumns() {
    if (!columns || busy) return;
    setBusy('columns');
    setError('');
    try {
      const saved = await api<DelhiveryBillingColumns>('/api/admin/delhivery-billing/columns', {
        method: 'PUT',
        body: columns,
        auth: true,
        success: 'Column mapping saved',
      });
      setColumns(saved);
      setColumnsView((v) => (v ? { ...v, columns: saved } : v));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the mapping');
    } finally {
      setBusy(null);
    }
  }

  async function adjust(line: DelhiveryBillingLineRow) {
    if (busy || !check) return;
    if (!window.confirm(confirmText(line))) return;
    setBusy(line.id);
    setError('');
    try {
      await api<DelhiveryBillingLineRow>(`/api/admin/delhivery-billing/lines/${line.id}/adjust`, {
        method: 'POST',
        body: { confirm: true },
        auth: true,
        success: `Adjustment posted to ${line.shopName ?? 'the seller'}'s ledger`,
      });
      setCheck(await api<DelhiveryBillingCheckView>(`/api/admin/delhivery-billing/checks/${check.id}`, { auth: true }));
      loadChecks();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not post the adjustment');
    } finally {
      setBusy(null);
    }
  }

  // Headers to pick from: the file just chosen, else the last one checked.
  const headers = useMemo(() => (file?.headers.length ? file.headers : (columnsView?.lastHeaders ?? [])), [file, columnsView]);
  const resolved = useMemo(() => (columns ? resolveBillingColumns(headers, columns) : null), [headers, columns]);
  const columnsDirty = !!columns && !!columnsView && JSON.stringify(columns) !== JSON.stringify(columnsView.columns);

  const shown = useMemo(
    () => check?.lines.filter((l) => (!statusFilter || l.status === statusFilter) && (!sellerFilter || (l.sellerId ?? 'none') === sellerFilter)) ?? [],
    [check, statusFilter, sellerFilter],
  );

  return (
    <div className="space-y-4 pb-10">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Delhivery billing check</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Delhivery&apos;s monthly bill, matched by AWB to what each seller was charged for the same parcel — forward, RTO,
          return pickup, and the charged weight. Nothing is posted until you confirm a line.
        </p>
      </div>

      {error && <p className="whitespace-pre-line rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <section className={CARD}>
        <h2 className="text-sm font-bold text-ink-900">Check a billing file</h2>
        <p className="mt-1 text-xs text-gray-500">
          Delhivery One → Finances → billing / MIS export, as CSV. Amounts in rupees; set which column holds what under Column
          mapping below if the guesses don&apos;t find them.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="text-xs text-gray-600">
            Month{' '}
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-600"
            />
          </label>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={!!busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void chooseFile(f);
              e.target.value = '';
            }}
            className="text-xs"
          />
          <button
            type="button"
            disabled={!file || !month || !!busy}
            aria-busy={busy === 'upload'}
            onClick={() => void upload()}
            className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {busy === 'upload' && <Spinner className="mr-1" />}
            Check {file ? file.name : 'file'}
          </button>
        </div>
        {file && resolved && resolved.awb < 0 && (
          <p className="mt-2 text-xs text-amber-700">No AWB column found in this file — pick it under Column mapping first.</p>
        )}
        {skipped.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-amber-700">{skipped.length} rows not read</summary>
            <ul className="mt-1 max-h-40 overflow-y-auto text-gray-600">
              {skipped.map((s) => (
                <li key={s.row}>
                  Row {s.row}: {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold text-ink-900">Column mapping</h2>
          <p className="text-[11px] text-gray-400">
            {file?.headers.length
              ? `Columns of ${file.name}`
              : columnsView?.lastFileName
                ? `Columns of the last file checked (${columnsView.lastFileName})`
                : 'Choose a file to pick its columns'}
          </p>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          &quot;Guess&quot; reads the header by its usual names (Waybill, AWB Number, Freight Charges…). Delhivery&apos;s export
          format isn&apos;t documented to us, so check the guess against the first file.
        </p>
        {!columns && <div className="mt-3 h-16 animate-pulse rounded-xl bg-gray-100" />}
        {columns && (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {DELHIVERY_BILLING_FIELDS.map((field) => {
                const options = [...headers];
                const chosen = columns[field];
                if (chosen && !options.includes(chosen)) options.unshift(chosen);
                const at = resolved?.[field] ?? -1;
                return (
                  <label key={field} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-gray-700">{DELHIVERY_BILLING_FIELD_LABELS[field]}</span>
                    <span className="flex items-center gap-2">
                      {headers.length > 0 && (
                        <span className={at >= 0 ? 'text-green-700' : 'text-gray-400'}>{at >= 0 ? `→ ${headers[at]}` : 'not found'}</span>
                      )}
                      <select
                        value={chosen ?? ''}
                        onChange={(e) => setColumns({ ...columns, [field]: e.target.value || null })}
                        className={`max-w-52 ${SELECT}`}
                      >
                        <option value="">Guess</option>
                        {options.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-2">
                Weight in
                <select
                  value={columns.weightUnit}
                  onChange={(e) => setColumns({ ...columns, weightUnit: e.target.value as DelhiveryBillingColumns['weightUnit'] })}
                  className={SELECT}
                >
                  <option value="KG">kg</option>
                  <option value="GRAMS">grams</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={columns.amountsIncludeGst}
                  onChange={(e) => setColumns({ ...columns, amountsIncludeGst: e.target.checked })}
                />
                Amounts already include GST
              </label>
              <span className="text-gray-400">
                {columns.amountsIncludeGst ? 'Read as they are.' : 'The GST column is added to them, or 18 % if there is none.'}
              </span>
              <button
                type="button"
                disabled={!columnsDirty || !!busy}
                aria-busy={busy === 'columns'}
                onClick={() => void saveColumns()}
                className="ml-auto rounded-lg border border-gray-300 px-3 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === 'columns' && <Spinner className="mr-1" />}
                Save mapping
              </button>
            </div>
          </>
        )}
      </section>

      {check && (
        <section className={CARD} data-billing-check>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-bold text-ink-900">
              {check.month} · {check.fileName}
            </h2>
            <p className="text-xs text-gray-500">
              Billed {formatPaise(check.summary.billedPaise)} · charged {formatPaise(check.summary.ledgerPaise)} · difference{' '}
              <span className="font-bold text-ink-900">{signed(check.summary.differencePaise)}</span>
            </p>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {DELHIVERY_BILLING_STATUSES.map((s) => `${check.summary.counts[s]} ${DELHIVERY_BILLING_STATUS_LABELS[s].toLowerCase()}`).join(' · ')}
          </p>

          <h3 className="mt-4 text-xs font-bold text-ink-900">Per seller</h3>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-gray-400">
                <tr>
                  <th className="py-1.5 pr-3 font-semibold">Seller</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Charges</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Off</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Billed</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Charged</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Difference</th>
                  <th className="py-1.5 text-right font-semibold">Not adjusted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {check.summary.sellers.map((s) => (
                  <tr key={s.sellerId ?? 'none'}>
                    <td className="py-1.5 pr-3">
                      <button
                        type="button"
                        onClick={() => setSellerFilter(s.sellerId ?? 'none')}
                        className="text-left font-semibold text-brand-700 hover:underline"
                      >
                        {s.sellerId ? (s.shopName ?? 'Seller') : 'Not our parcels'}
                      </button>
                    </td>
                    <td className="py-1.5 pr-3 text-right">{s.lines}</td>
                    <td className="py-1.5 pr-3 text-right">{s.mismatched}</td>
                    <td className="py-1.5 pr-3 text-right">{formatPaise(s.billedPaise)}</td>
                    <td className="py-1.5 pr-3 text-right">{formatPaise(s.ledgerPaise)}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold">{signed(s.differencePaise)}</td>
                    <td className="py-1.5 text-right">{signed(s.openDifferencePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-gray-400">+ the seller owes more than they were charged; − they were charged too much.</p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-xs font-bold text-ink-900">Charges</h3>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as DelhiveryBillingStatus | '')} className={SELECT}>
              <option value="">All statuses</option>
              {DELHIVERY_BILLING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {DELHIVERY_BILLING_STATUS_LABELS[s]} ({check.summary.counts[s]})
                </option>
              ))}
            </select>
            <select value={sellerFilter} onChange={(e) => setSellerFilter(e.target.value)} className={SELECT}>
              <option value="">All sellers</option>
              {check.summary.sellers.map((s) => (
                <option key={s.sellerId ?? 'none'} value={s.sellerId ?? 'none'}>
                  {s.sellerId ? (s.shopName ?? 'Seller') : 'Not our parcels'}
                </option>
              ))}
            </select>
          </div>
          {shown.length === 0 && <p className="mt-2 text-xs text-gray-400">No charges match.</p>}
          {shown.length > 0 && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-gray-400">
                  <tr>
                    <th className="py-1.5 pr-3 font-semibold">AWB</th>
                    <th className="py-1.5 pr-3 font-semibold">Trip</th>
                    <th className="py-1.5 pr-3 font-semibold">Seller · order</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Billed</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Charged</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Weight billed / charged</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Difference</th>
                    <th className="py-1.5 pr-3 font-semibold">Status</th>
                    <th className="py-1.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {shown.map((l) => {
                    const weightOff = l.billedWeightGrams !== null && l.ledgerWeightGrams !== null && l.billedWeightGrams !== l.ledgerWeightGrams;
                    const canAdjust = l.status !== 'UNKNOWN_AWB' && !!l.sellerId && l.differencePaise !== 0 && !l.adjustedAt;
                    return (
                      <tr key={l.id}>
                        <td className="py-1.5 pr-3 font-mono">{l.awbNumber}</td>
                        <td className="py-1.5 pr-3">{KIND_LABEL[l.kind]}</td>
                        <td className="py-1.5 pr-3">
                          {l.shopName ?? '—'}
                          {l.orderNumber && <span className="text-gray-400"> · {l.orderNumber}</span>}
                        </td>
                        <td className="py-1.5 pr-3 text-right">{formatPaise(l.billedPaise)}</td>
                        <td className="py-1.5 pr-3 text-right">{l.ledgerPaise === null ? '—' : formatPaise(l.ledgerPaise)}</td>
                        <td className={`py-1.5 pr-3 text-right ${weightOff ? 'font-semibold text-red-600' : ''}`}>
                          {kg(l.billedWeightGrams)} / {kg(l.ledgerWeightGrams)}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-semibold">{signed(l.differencePaise)}</td>
                        <td className={`py-1.5 pr-3 ${STATUS_TONE[l.status]}`}>{DELHIVERY_BILLING_STATUS_LABELS[l.status]}</td>
                        <td className="py-1.5 text-right">
                          {l.adjustedAt && <span className="text-[11px] text-green-700">Adjusted {new Date(l.adjustedAt).toLocaleDateString('en-IN')}</span>}
                          {canAdjust && (
                            <button
                              type="button"
                              disabled={!!busy}
                              aria-busy={busy === l.id}
                              onClick={() => void adjust(l)}
                              className="whitespace-nowrap rounded-lg border border-gray-300 px-2 py-0.5 text-[11px] font-semibold hover:bg-gray-50 disabled:opacity-50"
                            >
                              {busy === l.id && <Spinner className="mr-1" />}
                              Post adjustment
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {checks && checks.length > 0 && (
        <section className={CARD}>
          <h2 className="text-sm font-bold text-ink-900">Files checked</h2>
          <ul className="mt-2 divide-y divide-gray-50 text-xs">
            {checks.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void openCheck(c.id)}
                  className="text-left font-semibold text-brand-700 hover:underline disabled:opacity-50"
                >
                  {c.month} · {c.fileName}
                </button>
                <span className="text-gray-500">{new Date(c.createdAt).toLocaleString('en-IN')}</span>
                <span>
                  {c.counts.MATCHED} match · {c.counts.MISMATCH} differ · {c.counts.NOT_ON_LEDGER} not charged · {c.counts.UNKNOWN_AWB} not ours ·{' '}
                  <span className="font-semibold">{signed(c.differencePaise)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
