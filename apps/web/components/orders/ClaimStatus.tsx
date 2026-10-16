'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SELF_SHIP_MAX_PAISE, type MyReturnRow } from '@clowe/shared';
import { api, ApiRequestError, uploadPrivateImages } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/**
 * A claim's remedy and outcome on My Returns — the exchange sent, the item
 * sent back after a failed check (with why), and, where the courier cannot
 * collect, where to send it and the receipt to upload (Return Policy 7.2).
 */
export function ClaimStatus({ row, onChanged }: { row: MyReturnRow; onChanged: () => void }) {
  const [receipt, setReceipt] = useState<File | null>(null);
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (row.rules !== 'CLAIM') return null;

  async function sendReceipt() {
    const rupees = Number(cost);
    if (!receipt || !(rupees > 0)) {
      setError('Add the receipt and what you paid');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const [uploaded] = await uploadPrivateImages([receipt], 'RETURN_PHOTO');
      await api(`/api/me/returns/${row.id}/self-ship`, {
        auth: true,
        quiet: true,
        body: { receipt: uploaded!.ref, costPaise: Math.round(rupees * 100) },
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send the receipt');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 space-y-1" data-claim-status>
      <p className="t-caption text-gray-500">
        {row.rmaNumber} · you asked for{' '}
        <span className="font-medium text-ink-900">{row.remedy === 'EXCHANGE' ? 'an exchange' : 'a refund'}</span>
      </p>
      {row.replacementOrder && (
        <p className="t-caption font-semibold text-green-700">
          Exchange sent:{' '}
          <Link href={`/account/orders/${row.replacementOrder.id}`} className="underline">
            {row.replacementOrder.orderNumber}
          </Link>
        </p>
      )}
      {row.qcNote && (
        <p className="t-caption text-red-700">
          Did not pass the seller&apos;s check: {row.qcNote}
          {row.sentBackOrder && (
            <>
              {' '}
              — coming back to you as{' '}
              <Link href={`/account/orders/${row.sentBackOrder.id}`} className="font-semibold underline">
                {row.sentBackOrder.orderNumber}
              </Link>
            </>
          )}
        </p>
      )}
      {row.selfShip && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3" data-self-ship>
          <p className="t-caption font-bold text-amber-900">Please send this return yourself</p>
          <p className="t-caption mt-0.5 text-amber-900">
            The courier does not collect returns from your PIN code. Send it to:
          </p>
          {row.selfShip.sendTo ? (
            <p className="t-caption mt-1 whitespace-pre-line font-medium text-ink-900">
              {row.selfShip.sendTo.name}
              {'\n'}
              {row.selfShip.sendTo.line1}, {row.selfShip.sendTo.city}, {row.selfShip.sendTo.state} {row.selfShip.sendTo.pincode}
            </p>
          ) : (
            <p className="t-caption mt-1 text-ink-900">Contact support for the address.</p>
          )}
          {row.selfShip.reimbursedPaise ? (
            <p className="t-caption mt-2 font-semibold text-green-700">Courier charges reimbursed: {formatPaise(row.selfShip.reimbursedPaise)}</p>
          ) : row.selfShip.receiptUploaded ? (
            <p className="t-caption mt-2 text-gray-700">
              Receipt received ({formatPaise(row.selfShip.costPaise ?? 0)}). We reimburse up to {formatPaise(SELF_SHIP_MAX_PAISE)}.
            </p>
          ) : (
            <div className="mt-2 space-y-1.5">
              <p className="t-caption text-gray-700">Then upload the courier receipt — we reimburse up to {formatPaise(SELF_SHIP_MAX_PAISE)}.</p>
              <input type="file" name="selfShipReceipt" accept="image/jpeg,image/png,image/webp" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} className="block w-full text-xs" />
              <input
                type="number"
                name="selfShipCost"
                min={1}
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="What you paid (₹)"
                className="w-40 rounded-lg border border-gray-300 px-2 py-1 text-xs"
              />
              <button
                onClick={() => void sendReceipt()}
                disabled={busy}
                className="t-caption ml-2 rounded-lg bg-ink-900 px-3 py-1 font-bold text-white disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send receipt'}
              </button>
              {error && <p className="t-caption text-red-700">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
