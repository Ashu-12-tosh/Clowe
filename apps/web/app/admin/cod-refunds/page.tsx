'use client';

import { useCallback, useEffect, useState } from 'react';
import { codRefundPaidSchema, type CodRefundAccountView, type CodRefundRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { formatPaise } from '@/lib/format';

const CARD = 'rounded-2xl border border-gray-100 bg-white p-4';

/**
 * COD refunds to pay. A Cash on Delivery buyer is refunded by bank transfer
 * to the account they gave with their return. The account shows masked;
 * "Show details to pay" reveals it for the transfer (every reveal is in the
 * audit log); "Mark refunded" records the bank reference and tells the buyer.
 */
export default function CodRefundsPage() {
  const [tab, setTab] = useState<'PENDING' | 'PROCESSED'>('PENDING');
  const [rows, setRows] = useState<CodRefundRow[] | null>(null);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState<Record<string, CodRefundAccountView>>({});
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [refErrors, setRefErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setRows(null);
    api<CodRefundRow[]>(`/api/admin/cod-refunds?status=${tab}`, { auth: true })
      .then(setRows)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load'));
  }, [tab]);
  useEffect(load, [load]);

  async function reveal(row: CodRefundRow) {
    if (busy) return;
    setBusy(`reveal:${row.refundId}`);
    try {
      const account = await api<CodRefundAccountView>(`/api/admin/cod-refunds/${row.refundId}/reveal`, {
        method: 'POST',
        auth: true,
      });
      setRevealed((r) => ({ ...r, [row.refundId]: account }));
    } catch {
      // Reported by the API client.
    } finally {
      setBusy(null);
    }
  }

  async function markRefunded(row: CodRefundRow) {
    if (busy) return;
    const checked = codRefundPaidSchema.safeParse({ reference: refs[row.refundId] ?? '' });
    if (!checked.success) {
      setRefErrors((e) => ({ ...e, [row.refundId]: checked.error.issues[0]!.message }));
      return;
    }
    setRefErrors((e) => ({ ...e, [row.refundId]: '' }));
    setBusy(`paid:${row.refundId}`);
    try {
      await api(`/api/admin/cod-refunds/${row.refundId}/mark-refunded`, {
        method: 'POST',
        body: checked.data,
        auth: true,
        success: `Marked refunded — ${row.buyerName ?? 'the buyer'} has been told`,
      });
      setRevealed((r) => {
        const { [row.refundId]: _gone, ...rest } = r;
        return rest;
      });
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
        <h1 className="font-display text-2xl font-bold text-ink-900">COD refunds to pay</h1>
        <p className="mt-1 text-sm text-gray-500">
          Cash on Delivery buyers are refunded by bank transfer to an account in their own name. Pay each one from
          the company account, then mark it refunded with the bank&apos;s reference (UTR). Account details are shown
          masked; revealing them is logged.
        </p>
      </div>

      <div className="flex gap-2">
        {(['PENDING', 'PROCESSED'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide ${
              tab === t ? 'bg-ink-900 text-white' : 'border border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            {t === 'PENDING' ? 'To pay' : 'Paid'}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!rows && !error && <Spinner />}
      {rows && rows.length === 0 && (
        <p className={`${CARD} text-sm text-gray-500`}>{tab === 'PENDING' ? 'Nothing to pay right now.' : 'No COD refunds paid yet.'}</p>
      )}

      {rows?.map((row) => {
        const account = revealed[row.refundId];
        return (
          <section key={row.refundId} className={CARD} data-cod-refund={row.refundId}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-ink-900">
                  {formatPaise(row.amountPaise)} · {row.orderNumber}
                  {row.rmaNumber ? ` · ${row.rmaNumber}` : ''}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {row.itemTitle ?? 'Order refund'} · {row.buyerName ?? 'Buyer'} (+91 {row.buyerPhone}) ·{' '}
                  {new Date(row.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                </p>
              </div>
              <p className="text-xs font-semibold text-gray-700">
                Bank account: <span className="font-mono">{row.accountMasked ?? 'not given — contact the buyer'}</span>
              </p>
            </div>

            {tab === 'PROCESSED' ? (
              <p className="mt-2 text-xs text-green-700">
                Paid {row.paidAt ? new Date(row.paidAt).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : ''} ·
                reference <span className="font-mono">{row.reference}</span>
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {account ? (
                  <dl className="grid gap-1 rounded-xl bg-cream-100 p-3 text-xs sm:grid-cols-3">
                    <div>
                      <dt className="text-gray-500">Name</dt>
                      <dd className="font-semibold text-ink-900">{account.accountName}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-500">Account number</dt>
                      <dd className="font-mono font-semibold text-ink-900">{account.accountNumber}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-500">IFSC</dt>
                      <dd className="font-mono font-semibold text-ink-900">{account.ifsc}</dd>
                    </div>
                  </dl>
                ) : (
                  row.accountMasked && (
                    <button
                      onClick={() => void reveal(row)}
                      disabled={busy !== null}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-gray-700 hover:border-brand-600 disabled:opacity-50"
                    >
                      {busy === `reveal:${row.refundId}` ? 'Loading…' : 'Show details to pay'}
                    </button>
                  )
                )}
                <div className="flex flex-wrap items-start gap-2">
                  <label className="min-w-[14rem] flex-1 text-xs font-semibold text-gray-700">
                    Bank reference (UTR)
                    <input
                      name="reference"
                      value={refs[row.refundId] ?? ''}
                      onChange={(e) => setRefs((r) => ({ ...r, [row.refundId]: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm font-normal outline-none focus:border-brand-600"
                    />
                    {refErrors[row.refundId] && <span className="mt-1 block text-red-600">{refErrors[row.refundId]}</span>}
                  </label>
                  <button
                    onClick={() => void markRefunded(row)}
                    disabled={busy !== null}
                    className="mt-5 rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                  >
                    {busy === `paid:${row.refundId}` ? 'Saving…' : 'Mark refunded'}
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
