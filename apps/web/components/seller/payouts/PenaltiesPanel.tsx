'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { SellerPenaltiesView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Late-dispatch penalties, always on the payouts page: the rule as settings
 * run it now, then every penalty with its order, date, amount, reason and
 * whether it was waived. With none, the rule still shows, so a seller learns
 * it before it costs them.
 */
export function PenaltiesPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<SellerPenaltiesView | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<SellerPenaltiesView>('/api/seller/ledger/penalties', { auth: true }));
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load penalties');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const rule = data?.rule;

  return (
    <section className="rounded-2xl border border-gray-100 bg-white" data-penalties>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-ink-900">Penalties</h2>
          <p className="mt-0.5 break-words text-[11px] text-gray-500" data-penalty-rule>
            {!rule
              ? 'Late-dispatch penalties and why they were charged.'
              : rule.enabled
                ? `${formatPaise(rule.penaltyPaise)} per order not dispatched within ${rule.afterHours} hours of being placed (the dispatch promise is ${rule.slaHours} hours). It is charged when the ${rule.afterHours} hours run out, shipped or not, comes off your settlement balance, and is paused while your store is on vacation. Support can waive it if the delay was not yours.${
                    rule.effectiveFrom
                      ? ` It applies to orders placed from ${new Date(rule.effectiveFrom).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          timeZone: 'Asia/Kolkata',
                        })}.`
                      : ''
                  }`
                : `Late-dispatch penalties are switched off right now. When on, each order not dispatched within ${rule.afterHours} hours of being placed costs ${formatPaise(rule.penaltyPaise)}.`}
          </p>
        </div>
        {data && (
          <dl className="flex flex-wrap gap-4 text-xs">
            <div>
              <dt className="text-gray-500">Charged</dt>
              <dd className="font-bold text-ink-900">{formatPaise(data.chargedPaise)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Waived</dt>
              <dd className="font-bold text-green-700">{formatPaise(data.waivedPaise)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Net cost</dt>
              <dd className={`font-bold ${data.netPaise > 0 ? 'text-red-600' : 'text-ink-900'}`}>
                {formatPaise(data.netPaise)}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {error && <p className="px-4 py-3 text-xs text-red-600">{error}</p>}

      {data && data.rows.length === 0 && (
        <p className="px-4 py-6 text-center text-xs text-gray-400" data-penalties-empty>
          No penalties. Every order you have shipped went out on time.
        </p>
      )}

      {data && data.rows.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {data.rows.map((row) => (
            <li
              key={row.entryId}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 text-xs"
              data-penalty-row
            >
              <div className="min-w-0 flex-1">
                <p className="break-words font-semibold text-ink-900">
                  {row.orderId && row.orderNumber ? (
                    <Link href={`/seller/orders/${row.orderId}`} className="text-brand-600 hover:underline">
                      {row.orderNumber}
                    </Link>
                  ) : (
                    (row.orderNumber ?? 'Order')
                  )}
                  {row.itemTitle && <span className="font-normal text-gray-500"> · {row.itemTitle}</span>}
                </p>
                <p className="mt-0.5 break-words text-gray-500">
                  {day(row.chargedAt)}
                  {row.reason && <> · {row.reason}</>}
                </p>
                {row.waived && row.waiverNote && (
                  <p className="mt-0.5 break-words text-green-700">{row.waiverNote}</p>
                )}
              </div>
              <div className="text-right">
                <p className={`font-semibold ${row.waived ? 'text-gray-400 line-through' : 'text-red-600'}`}>
                  − {formatPaise(row.amountPaise)}
                </p>
                <span
                  className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    row.waived ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                  }`}
                >
                  {row.waived ? `Waived${row.waivedAt ? ` ${day(row.waivedAt)}` : ''}` : 'Charged'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && data.total > data.rows.length && (
        <p className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          Showing the latest {data.rows.length} of {data.total}. All of them are in the ledger below.
        </p>
      )}
    </section>
  );
}
