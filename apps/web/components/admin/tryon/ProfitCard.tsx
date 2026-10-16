'use client';

import { useEffect, useState } from 'react';
import type { TryOnProfitReport } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/**
 * Admin only (owner's Batch 2): a month of try-on credit economics — what
 * sellers paid for credits (before GST), what the images cost Clowe at the
 * admin's cost per credit, and the profit. Never shown to sellers.
 */
export default function TryOnProfitCard() {
  const [month, setMonth] = useState(() => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7));
  const [r, setR] = useState<TryOnProfitReport | null>(null);
  useEffect(() => {
    api<TryOnProfitReport>(`/api/admin/tryon/profit?month=${month}`, { auth: true }).then(setR).catch(() => setR(null));
  }, [month]);
  const cells: [string, string][] = r
    ? [
        ['Credits sold', r.creditsSold.toLocaleString('en-IN')],
        ['Free credits given', r.creditsGranted.toLocaleString('en-IN')],
        ['Credits used', r.creditsUsed.toLocaleString('en-IN')],
        ['Free repeats', r.freeRepeats.toLocaleString('en-IN')],
        ['Failed (free)', r.failedRuns.toLocaleString('en-IN')],
        ['Revenue (ex-GST)', formatPaise(r.revenuePaise)],
        [`Cost (${r.successfulRuns} images × ${formatPaise(r.costPerCreditPaise)})`, formatPaise(r.estimatedCostPaise)],
        ['Profit', formatPaise(r.profitPaise)],
      ]
    : [];
  return (
    <section className="mt-5 rounded-2xl border border-gray-100 bg-white p-4" data-tryon-profit>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-ink-900">Credit economics — admin only</h2>
          {r && (
            <p className="text-[11px] text-gray-500">
              {r.phaseNote} Cost per credit now {formatPaise(r.costPerCreditPaise)}; at volume {r.tierCostsPaise.map((t) => formatPaise(t)).join(' / ')}. Provider-logged cost this month: {formatPaise(r.providerCostPaise)}.
            </p>
          )}
        </div>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="rounded border border-gray-200 px-2 py-1 text-xs" />
      </div>
      {r && (
        <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {cells.map(([k, v]) => (
            <div key={k} className="rounded-xl bg-cream-50 p-2.5">
              <dt className="text-[11px] text-gray-500">{k}</dt>
              <dd className={`font-display text-base font-bold ${k === 'Profit' && r.profitPaise < 0 ? 'text-red-600' : 'text-ink-900'}`}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
