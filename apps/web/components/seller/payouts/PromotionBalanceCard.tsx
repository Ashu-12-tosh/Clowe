'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SELLER_LEDGER_TYPE_LABELS, type SellerLedgerPage } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/**
 * The promotion balance at a glance on the payouts page: what is left, the
 * last few purchases and spends, and where to buy more. Credits are not
 * payable money, so this sits beside the settlement figures, never in them.
 * Buying happens on the dashboard's promotion card.
 */
export function PromotionBalanceCard() {
  const [data, setData] = useState<SellerLedgerPage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<SellerLedgerPage>('/api/seller/ledger?bucket=PROMOTION&page=1&pageSize=5', { auth: true })
      .then((page) => setData(page))
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load the promotion balance'),
      );
  }, []);

  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4" data-promotion-balance>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold text-ink-900">Promotion balance</h2>
        <Link
          href="/seller#promotion-credits"
          className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          Buy credits
        </Link>
      </div>
      <p className="mt-1 break-words text-[11px] text-gray-500">
        Prepaid credits for ad placements. Spent when you book an ad, returned if it is declined, never
        paid out.
      </p>
      <p className="mt-2 font-display text-2xl font-bold text-ink-900" data-promotion-balance-amount>
        {data ? formatPaise(data.balancePaise) : '—'}
      </p>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <h3 className="mt-4 text-[11px] font-bold uppercase tracking-wide text-gray-500">
        Recent purchases and spends
      </h3>
      {data && data.rows.length === 0 && (
        <p className="mt-2 text-xs text-gray-400" data-promotion-empty>
          No purchases or spends yet.
        </p>
      )}
      {data && data.rows.length > 0 && (
        <ul className="mt-2 divide-y divide-gray-100 text-xs">
          {data.rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
              <span className="min-w-0 break-words">
                <span className="font-semibold text-ink-900">
                  {SELLER_LEDGER_TYPE_LABELS[row.type] ?? row.type}
                </span>{' '}
                <span className="text-gray-400">
                  {new Date(row.createdAt).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    timeZone: 'Asia/Kolkata',
                  })}
                </span>
              </span>
              <span className={`font-semibold ${row.amountPaise < 0 ? 'text-red-600' : 'text-green-700'}`}>
                {row.amountPaise < 0 ? '− ' : '+ '}
                {formatPaise(Math.abs(row.amountPaise))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && data.total > data.rows.length && (
        <Link
          href="/seller#promotion-credits"
          className="mt-2 inline-block text-[11px] font-semibold text-brand-600 hover:underline"
        >
          Full credits history →
        </Link>
      )}
    </section>
  );
}
