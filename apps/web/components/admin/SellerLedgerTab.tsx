'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  SELLER_LEDGER_TYPE_LABELS,
  type SellerLedgerBucketValue,
  type SellerLedgerPage,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

function signed(paise: number): string {
  return paise < 0 ? `− ${formatPaise(-paise)}` : `+ ${formatPaise(paise)}`;
}

/**
 * The seller's ledger as the admin sees it, with one power the seller does
 * not have: forgiving a late-dispatch penalty. The server refuses a second
 * waiver on the same line, so the button only disappears once it has been
 * reloaded as waived.
 */
export default function SellerLedgerTab({ sellerId }: { sellerId: string }) {
  const [bucket, setBucket] = useState<SellerLedgerBucketValue>('SETTLEMENT');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SellerLedgerPage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(
        await api<SellerLedgerPage>(
          `/api/admin/sellers/${sellerId}/ledger?bucket=${bucket}&page=${page}&pageSize=20`,
          { auth: true },
        ),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load the ledger');
    }
  }, [sellerId, bucket, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Which lines already carry a waiver, so the button is not offered twice.
  const waivedItems = new Set(
    data?.rows.filter((r) => r.type === 'PENALTY_WAIVER').map((r) => r.reference.orderItemId) ?? [],
  );

  async function waive(entryId: string) {
    const reason = prompt('Why is this penalty being waived? (shown on the audit log)');
    if (!reason || reason.trim().length < 5) return;
    setBusy(entryId);
    try {
      await api(`/api/admin/sellers/${sellerId}/ledger/${entryId}/waive`, {
        method: 'POST',
        body: { reason: reason.trim() },
        auth: true,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not waive the penalty');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg bg-cream-100 p-0.5 text-[11px] font-semibold">
          {(['SETTLEMENT', 'PROMOTION'] as const).map((b) => (
            <button
              key={b}
              onClick={() => {
                setBucket(b);
                setPage(1);
              }}
              className={`rounded-md px-2.5 py-1 ${bucket === b ? 'bg-white text-ink-900' : 'text-gray-500'}`}
            >
              {b === 'SETTLEMENT' ? 'Settlement' : 'Promotion credits'}
            </button>
          ))}
        </div>
        {data && (
          <p className="text-xs text-gray-500">
            Balance{' '}
            <span className={`font-bold ${data.balancePaise < 0 ? 'text-red-600' : 'text-ink-900'}`}>
              {data.balancePaise < 0 ? '− ' : ''}
              {formatPaise(Math.abs(data.balancePaise))}
            </span>
          </p>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <ul className="mt-3 divide-y divide-gray-100 text-xs">
        {data?.rows.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="font-semibold text-ink-900">
                {SELLER_LEDGER_TYPE_LABELS[row.type] ?? row.type}
                <span className="ml-2 font-normal text-gray-400">
                  {new Date(row.createdAt).toLocaleString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </p>
              <p className="truncate text-gray-500">
                {row.reference.payoutReference ??
                  row.reference.orderNumber ??
                  (row.reference.adId ? `Ad ${row.reference.adId.slice(-6).toUpperCase()}` : '')}
                {row.note ? ` · ${row.note}` : ''}
              </p>
              {row.type === 'LATE_DISPATCH_PENALTY' &&
                row.reference.orderItemId &&
                !waivedItems.has(row.reference.orderItemId) && (
                  <button
                    disabled={busy !== null}
                    onClick={() => void waive(row.id)}
                    className="mt-1 rounded-md border border-gray-300 px-2 py-0.5 text-[11px] font-semibold hover:bg-gray-50 disabled:opacity-50"
                  >
                    {busy === row.id ? 'Waiving…' : 'Waive penalty'}
                  </button>
                )}
            </div>
            <div className="shrink-0 text-right">
              <p className={`font-semibold ${row.amountPaise < 0 ? 'text-red-600' : 'text-green-700'}`}>
                {signed(row.amountPaise)}
              </p>
              <p className="text-[11px] text-gray-400">
                bal {row.runningBalancePaise < 0 ? '− ' : ''}
                {formatPaise(Math.abs(row.runningBalancePaise))}
              </p>
            </div>
          </li>
        ))}
        {data && data.rows.length === 0 && <li className="py-6 text-center text-gray-400">No entries.</li>}
        {!data && !error && <li className="py-6 text-center text-gray-400">Loading…</li>}
      </ul>

      {data && data.totalPages > 1 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs">
          <button
            disabled={data.page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold disabled:opacity-40"
          >
            ‹
          </button>
          <span className="text-gray-600">
            Page {data.page} / {data.totalPages}
          </span>
          <button
            disabled={data.page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold disabled:opacity-40"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
