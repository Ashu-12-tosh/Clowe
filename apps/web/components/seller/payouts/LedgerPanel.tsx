'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  SELLER_LEDGER_TYPE_LABELS,
  type SellerLedgerBucketValue,
  type SellerLedgerEntryRow,
  type SellerLedgerPage,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/** Money with its sign, so a deduction reads as one at a glance. */
function signed(paise: number): string {
  if (paise < 0) return `− ${formatPaise(-paise)}`;
  return `+ ${formatPaise(paise)}`;
}

function referenceOf(row: SellerLedgerEntryRow): string {
  const r = row.reference;
  if (r.payoutReference) return r.payoutReference;
  if (r.orderNumber) return r.itemTitle ? `${r.orderNumber} · ${r.itemTitle}` : r.orderNumber;
  if (r.adId) return `Ad ${r.adId.slice(-6).toUpperCase()}`;
  return '—';
}

/**
 * One bucket of the seller's ledger: date, type, reference, amount and the
 * balance after each row. `refreshKey` lets the page reload it after a
 * payout or a purchase without the panel knowing which.
 */
export function LedgerPanel({
  bucket,
  title,
  subtitle,
  refreshKey = 0,
  pageSize = 20,
}: {
  bucket: SellerLedgerBucketValue;
  title: string;
  subtitle?: string;
  refreshKey?: number;
  pageSize?: number;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SellerLedgerPage | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(
        await api<SellerLedgerPage>(
          `/api/seller/ledger?bucket=${bucket}&page=${page}&pageSize=${pageSize}`,
          { auth: true },
        ),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load the ledger');
    }
  }, [bucket, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <section className="rounded-2xl border border-gray-100 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-bold text-ink-900">{title}</h2>
          {subtitle && <p className="text-[11px] text-gray-400">{subtitle}</p>}
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

      {error && <p className="px-4 py-3 text-xs text-red-600">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="text-left uppercase tracking-wide text-gray-500">
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Reference</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((row) => (
              <tr key={row.id} className="border-t border-gray-100">
                <td className="whitespace-nowrap px-4 py-2 text-gray-500">
                  {new Date(row.createdAt).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                  <span className="block text-[11px] text-gray-400">
                    {new Date(row.createdAt).toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="font-semibold text-ink-900">
                    {SELLER_LEDGER_TYPE_LABELS[row.type] ?? row.type}
                  </span>
                  {row.note && <span className="block text-[11px] text-gray-400">{row.note}</span>}
                </td>
                <td className="max-w-[220px] truncate px-3 py-2 text-gray-600" title={referenceOf(row)}>
                  {referenceOf(row)}
                </td>
                <td
                  className={`whitespace-nowrap px-3 py-2 text-right font-semibold ${
                    row.amountPaise < 0 ? 'text-red-600' : 'text-green-700'
                  }`}
                >
                  {signed(row.amountPaise)}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right font-semibold text-ink-900">
                  {row.runningBalancePaise < 0 ? '− ' : ''}
                  {formatPaise(Math.abs(row.runningBalancePaise))}
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  Nothing here yet.
                </td>
              </tr>
            )}
            {!data && !error && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2.5 text-xs">
          <p className="text-gray-500">
            {data.total} entr{data.total === 1 ? 'y' : 'ies'}
          </p>
          <div className="flex items-center gap-2">
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
        </div>
      )}
    </section>
  );
}
