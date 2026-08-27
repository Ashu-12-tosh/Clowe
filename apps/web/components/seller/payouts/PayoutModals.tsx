'use client';

import { useEffect, useState } from 'react';
import {
  PAYOUT_STATUS_LABELS,
  type PayoutMethodTypeValue,
  type PayoutStatusValue,
  type SellerPayoutDetail,
  type SellerPayoutMethodRow,
  type SellerPayoutRow,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

export const PAYOUT_STATUS_STYLES: Record<PayoutStatusValue, string> = {
  PENDING: 'bg-yellow-100 text-yellow-700',
  PROCESSING: 'bg-blue-100 text-blue-700',
  PAID: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
};

export function PayoutStatusPill({ status }: { status: PayoutStatusValue }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${PAYOUT_STATUS_STYLES[status]}`}
    >
      {PAYOUT_STATUS_LABELS[status]}
    </span>
  );
}

function money(paise: number): string {
  return formatPaise(paise);
}

/** Add a bank account or UPI ID; the provider penny-drops it before saving. */
export function AddMethodModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (method: SellerPayoutMethodRow) => void;
}) {
  const [type, setType] = useState<PayoutMethodTypeValue>('BANK');
  const [label, setLabel] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [upiId, setUpiId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      const method = await api<SellerPayoutMethodRow>('/api/seller/payouts/methods', {
        method: 'POST',
        body: {
          type,
          label: label.trim(),
          accountName: accountName.trim(),
          ...(type === 'BANK'
            ? { accountNumber: accountNumber.trim(), ifsc: ifsc.trim().toUpperCase() }
            : { upiId: upiId.trim() }),
          makeDefault: true,
        },
        auth: true,
      });
      onSaved(method);
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save this method');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-ink-900">Add payout method</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Only the last 4 digits are stored here — the full number stays with the payout
              provider.
            </p>
          </div>
          <button onClick={onClose} className="rounded-full px-2 py-1 text-gray-500 hover:bg-gray-100">
            ✕
          </button>
        </div>

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-4 flex gap-2">
          {(['BANK', 'UPI'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${
                type === t ? 'bg-ink-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {t === 'BANK' ? '🏦 Bank account' : '📱 UPI'}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-500">
              Name for this method (e.g. HDFC Bank)
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500">Account holder name</label>
            <input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
            />
          </div>
          {type === 'BANK' ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-500">Account number</label>
                <input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  inputMode="numeric"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500">IFSC</label>
                <input
                  value={ifsc}
                  onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                  placeholder="HDFC0001234"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm uppercase outline-none focus:border-brand-600"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="text-xs font-semibold text-gray-500">UPI ID</label>
              <input
                value={upiId}
                onChange={(e) => setUpiId(e.target.value)}
                placeholder="shopname@okhdfcbank"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
          >
            {busy ? 'Verifying…' : 'Verify & save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Everything one payout settled: the lines, the fees and the bank reference. */
export function PayoutDetailDrawer({
  payout,
  onClose,
}: {
  payout: SellerPayoutRow;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SellerPayoutDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<SellerPayoutDetail>(`/api/seller/payouts/${payout.id}`, { auth: true })
      .then(setDetail)
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load this payout'),
      );
  }, [payout.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-900/40" onClick={onClose}>
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4">
          <div>
            <p className="font-mono text-sm font-bold text-brand-600">{payout.reference}</p>
            <p className="text-xs text-gray-500">
              {new Date(payout.periodFrom).toLocaleDateString('en-IN')} –{' '}
              {new Date(payout.periodTo).toLocaleDateString('en-IN')} · {payout.itemCount} item(s)
            </p>
          </div>
          <button onClick={onClose} className="rounded-full px-3 py-1 text-sm text-gray-500 hover:bg-gray-100">
            ✕
          </button>
        </header>

        {error && <p className="mx-5 mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="space-y-4 p-5">
          <div className="rounded-2xl border border-gray-100 p-4">
            <div className="flex items-center justify-between">
              <PayoutStatusPill status={payout.status} />
              <p className="font-display text-xl font-bold text-ink-900">{money(payout.netPaise)}</p>
            </div>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <dt className="text-gray-500">Gross sales settled</dt>
                <dd>{money(payout.grossPaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Commission</dt>
                <dd className="text-red-600">− {money(payout.commissionPaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Payment gateway / collection</dt>
                <dd className="text-red-600">− {money(payout.gatewayPaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">TDS (194-O)</dt>
                <dd className="text-red-600">− {money(payout.tdsPaise)}</dd>
              </div>
              {payout.adjustmentPaise > 0 && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Ad spend recovered</dt>
                  <dd className="text-red-600">− {money(payout.adjustmentPaise)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-gray-100 pt-1.5 text-sm font-bold text-ink-900">
                <dt>Transferred</dt>
                <dd>{money(payout.netPaise)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-gray-500">
              To {payout.methodLabel ?? '—'}
              {payout.utr && (
                <>
                  {' '}
                  · UTR <span className="font-mono font-semibold text-ink-900">{payout.utr}</span>
                </>
              )}
              {payout.processedAt && <> · {new Date(payout.processedAt).toLocaleString('en-IN')}</>}
            </p>
            {payout.failureReason && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {payout.failureReason}
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-gray-100 p-4">
            <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
              Items settled in this payout
            </h3>
            {!detail && !error && <p className="mt-2 text-sm text-gray-500">Loading…</p>}
            {detail && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase tracking-wide text-gray-500">
                      <th className="pb-2 font-semibold">Order</th>
                      <th className="pb-2 font-semibold">Item</th>
                      <th className="pb-2 text-right font-semibold">Gross</th>
                      <th className="pb-2 text-right font-semibold">Fees</th>
                      <th className="pb-2 text-right font-semibold">TDS</th>
                      <th className="pb-2 text-right font-semibold">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.orderItemId} className="border-t border-gray-100">
                        <td className="py-1.5 font-mono">{line.orderNumber}</td>
                        <td className="max-w-40 truncate py-1.5">
                          {line.title}
                          {line.quantity > 1 && <span className="text-gray-400"> ×{line.quantity}</span>}
                        </td>
                        <td className="py-1.5 text-right">{money(line.grossPaise)}</td>
                        <td className="py-1.5 text-right text-red-600">
                          {money(line.commissionPaise + line.gatewayPaise)}
                        </td>
                        <td className="py-1.5 text-right text-red-600">{money(line.tdsPaise)}</td>
                        <td className="py-1.5 text-right font-semibold">{money(line.netPaise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {detail && detail.adjustments.length > 0 && (
            <div className="rounded-2xl border border-gray-100 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Adjustments recovered
              </h3>
              <ul className="mt-2 space-y-1 text-xs">
                {detail.adjustments.map((a) => (
                  <li key={a.id} className="flex justify-between">
                    <span className="text-gray-600">
                      Ad · {a.placement.replace(/_/g, ' ').toLowerCase()} ·{' '}
                      {new Date(a.createdAt).toLocaleDateString('en-IN')}
                    </span>
                    <span className="text-red-600">− {money(a.pricePaise)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
