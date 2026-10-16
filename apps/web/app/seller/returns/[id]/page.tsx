'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RETURN_REASON_LABELS, type ReturnReasonValue, type SellerReturnRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { formatPaise } from '@/lib/format';
import { ExternalLink } from '@/components/ExternalLink';
import { PackingVideoEvidence } from '@/components/seller/orders/PackingVideoPanel';
import { ClaimEvidence } from '@/components/orders/ClaimEvidence';

const returnStatusStyles: Record<string, string> = {
  REQUESTED: 'bg-orange-100 text-orange-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  REJECTED: 'bg-red-100 text-red-700',
  RECEIVED: 'bg-purple-100 text-purple-700',
  REFUNDED: 'bg-green-100 text-green-700',
};

export default function SellerReturnDetailPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = use(paramsPromise);
  const [row, setRow] = useState<SellerReturnRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  // 'pickup', 'approve', 'reject', 'received:OK' or 'received:DAMAGED' while it runs.
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [receiving, setReceiving] = useState(false);
  const [qcNote, setQcNote] = useState('');

  const load = useCallback(() => {
    api<SellerReturnRow>(`/api/seller/returns/${params.id}`, { auth: true })
      .then(setRow)
      .catch(() => setNotFound(true));
  }, [params.id]);
  useEffect(load, [load]);

  async function bookPickup() {
    if (busy) return;
    setError('');
    setBusy('pickup');
    try {
      setRow(
        await api<SellerReturnRow>(`/api/seller/returns/${params.id}/pickup`, {
          method: 'POST',
          auth: true,
          success: 'Delhivery pickup booked',
        }),
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not book the pickup');
    } finally {
      setBusy(null);
    }
  }

  async function act(body: Record<string, string>) {
    if (busy) return;
    setError('');
    const key = body.action === 'received' ? `received:${body.condition}` : body.action!;
    setBusy(key);
    try {
      const updated = await api<SellerReturnRow>(`/api/seller/returns/${params.id}`, {
        method: 'PATCH',
        body,
        auth: true,
        success:
          key === 'approve'
            ? 'Return approved'
            : key === 'reject'
              ? 'Return rejected'
              : key === 'received:OK'
                ? row?.claim
                  ? row.claim.remedy === 'EXCHANGE'
                    ? 'Passed — send the exchange from Orders'
                    : 'Passed — the refund is on its way'
                  : 'Received — the refund is on its way'
                : row?.claim
                  ? 'Failed — send the item back to the buyer from Orders'
                  : 'Marked damaged — support will look at it',
      });
      setRow(updated);
      setRejecting(false);
      setReceiving(false);
      // The detail (claim evidence, outcome) comes from the full view.
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  if (notFound) {
    return (
      <div className="py-10 text-center text-sm text-gray-600">
        Return not found.{' '}
        <Link href="/seller/returns" className="font-semibold text-brand-600 hover:underline">
          ← All returns
        </Link>
      </div>
    );
  }
  if (!row) return <p className="text-sm text-gray-500">Loading…</p>;

  const itemTotal = formatPaise(row.pricePaise * row.quantity);

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/seller/returns" className="text-xs text-gray-400 hover:text-gray-600">
        ← All returns
      </Link>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{row.orderNumber}</h1>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${returnStatusStyles[row.status] ?? ''}`}>
          {row.status}
        </span>
      </div>
      {row.adminOverrideAt && (
        <p className="mt-1 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-700">
          ⚖️ Clowe support reviewed this return and approved it (seller decision overridden on{' '}
          {new Date(row.adminOverrideAt).toLocaleDateString('en-IN')}). Please process the pickup.
        </p>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Item */}
      <div className="mt-4 flex gap-4 rounded-2xl border border-gray-100 bg-white p-4">
        {row.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.imageUrl} alt="" className="h-24 w-20 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="h-24 w-20 shrink-0 rounded-lg bg-gray-100" />
        )}
        <div className="min-w-0 text-sm">
          <p className="font-semibold">{row.title}</p>
          <p className="mt-0.5 text-gray-500">
            {row.color} / {row.size} · qty {row.quantity}
          </p>
          <p className="mt-1 font-bold">{itemTotal}</p>
          <p className="mt-1 text-xs text-gray-500">
            Customer: {row.customerName} · requested{' '}
            {new Date(row.requestedAt).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </p>
        </div>
      </div>

      {/* Reason + photos */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">Customer&apos;s reason</h2>
        <p className="mt-1.5 text-sm font-semibold text-ink-900">
          {RETURN_REASON_LABELS[row.reason as ReturnReasonValue] ?? row.reason}
        </p>
        {row.details && <p className="mt-1 text-sm text-gray-600">&ldquo;{row.details}&rdquo;</p>}
        {row.photos.length > 0 && (
          <div className="mt-3 flex gap-2">
            {row.photos.map((url) => (
              <ExternalLink key={url} href={url}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="Return photo" className="h-24 w-24 rounded-lg object-cover transition hover:opacity-80" />
              </ExternalLink>
            ))}
          </div>
        )}
        {/* What went into the box, beside what the buyer says came out. */}
        {row.claim && <ClaimEvidence claim={row.claim} />}
        <div className="mt-4">
          <PackingVideoEvidence video={row.packingVideo} />
        </div>
        {row.rejectionReason && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            Declined: {row.rejectionReason}
          </p>
        )}
        {row.receivedCondition && (
          <p className="mt-3 text-xs text-gray-600">
            Received condition:{' '}
            <span className={`font-semibold ${row.receivedCondition === 'OK' ? 'text-green-700' : 'text-red-600'}`}>
              {row.receivedCondition === 'OK' ? 'OK' : 'Damaged'}
            </span>
          </p>
        )}
      </div>

      {/* Refund state */}
      {row.refund && (
        <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4 text-sm">
          <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">Refund</h2>
          <p className="mt-1.5">
            {formatPaise(row.refund.amountPaise)} ·{' '}
            <span
              className={`font-semibold ${
                row.refund.status === 'PROCESSED'
                  ? 'text-green-700'
                  : row.refund.status === 'FAILED'
                    ? 'text-red-600'
                    : 'text-orange-600'
              }`}
            >
              {row.refund.status}
            </span>
            {row.refund.providerRefundId && (
              <span className="ml-2 font-mono text-xs text-gray-400">{row.refund.providerRefundId}</span>
            )}
          </p>
        </div>
      )}

      {/* Actions */}
      {row.status === 'REQUESTED' && !rejecting && (
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button
            onClick={() => void act({ action: 'approve' })}
            disabled={!!busy}
            className="flex-1 rounded-xl bg-ink-900 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
          >
            {busy === 'approve' && <Spinner className="mr-1" />}
            ✓ Approve return
          </button>
          <button
            onClick={() => setRejecting(true)}
            disabled={!!busy}
            className="flex-1 rounded-xl border border-red-300 py-3 text-sm font-bold uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            ✕ Reject return
          </button>
        </div>
      )}

      {rejecting && (
        <div className="mt-5 rounded-2xl border border-red-200 bg-red-50/50 p-4">
          <p className="text-sm font-semibold text-ink-900">Why are you rejecting this return?</p>
          <p className="mt-0.5 text-xs text-gray-500">The customer will see this reason.</p>
          <textarea
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder="e.g. Item shows signs of use; tags removed"
            className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
            autoFocus
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void act({ action: 'reject', rejectionReason: rejectionReason.trim() })}
              disabled={!!busy || rejectionReason.trim().length < 5}
              className="rounded-lg bg-red-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy === 'reject' && <Spinner className="mr-1" />}
              Confirm rejection
            </button>
            <button
              onClick={() => setRejecting(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {row.status === 'APPROVED' && (
        <div className="mt-5 rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs" data-return-pickup>
          {row.pickup ? (
            <p className="text-gray-700">
              <span className="font-semibold text-ink-900">Delhivery pickup booked</span> — AWB{' '}
              <span className="font-mono">{row.pickup.awbNumber ?? '—'}</span>
              {row.pickup.status === 'DELIVERED'
                ? ' · delivered back to you: inspect it and mark it received.'
                : row.pickup.status === 'IN_TRANSIT'
                  ? ' · collected from the buyer, on its way to you.'
                  : ' · Delhivery will collect it from the buyer.'}
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-amber-800">No Delhivery pickup is booked for this return yet.</p>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void bookPickup()}
                className="rounded-lg bg-ink-900 px-3 py-1.5 font-bold uppercase tracking-wide text-white disabled:opacity-50"
              >
                {busy === 'pickup' && <Spinner className="mr-1" />}
                Book pickup
              </button>
            </div>
          )}
        </div>
      )}

      {row.status === 'APPROVED' && !receiving && (
        <button
          onClick={() => setReceiving(true)}
          className="mt-5 w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 sm:w-auto sm:px-8"
        >
          📦 Item received back
        </button>
      )}

      {receiving && (
        <div className="mt-5 rounded-2xl border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-ink-900">{row.claim ? 'Quality check' : 'What condition is the item in?'}</p>
          <p className="mt-0.5 text-xs text-gray-500">
            {row.claim
              ? `Passed → ${row.claim.remedy === 'EXCHANGE' ? 'an identical item is ordered for you to ship free (refunded instead if none is in stock)' : `the buyer is refunded ${itemTotal}`}. Failed (used, altered, substituted, not what you sent) → the item goes back to the buyer and their account is reviewed; say what you found.`
              : `OK → the refund of ${itemTotal} is initiated automatically. Damaged → no auto-refund; support steps in.`}
          </p>
          {row.claim && (
            <textarea
              name="qcNote"
              value={qcNote}
              onChange={(e) => setQcNote(e.target.value)}
              maxLength={300}
              rows={2}
              placeholder="What the check found (required if it failed — the buyer sees this)"
              className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
            />
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void act({ action: 'received', condition: 'OK', ...(qcNote.trim() ? { note: qcNote.trim() } : {}) })}
              disabled={!!busy}
              className="rounded-lg bg-green-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy === 'received:OK' && <Spinner className="mr-1" />}
              {row.claim ? (row.claim.remedy === 'EXCHANGE' ? '✓ Passed — exchange' : `✓ Passed — refund ${itemTotal}`) : `✓ Condition OK — refund ${itemTotal}`}
            </button>
            <button
              onClick={() => void act({ action: 'received', condition: 'DAMAGED', ...(qcNote.trim() ? { note: qcNote.trim() } : {}) })}
              disabled={!!busy || (!!row.claim && qcNote.trim().length < 5)}
              className="rounded-lg border border-red-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              {busy === 'received:DAMAGED' && <Spinner className="mr-1" />}
              {row.claim ? 'Failed the check' : 'Damaged on arrival'}
            </button>
            <button
              onClick={() => setReceiving(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-cream-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
