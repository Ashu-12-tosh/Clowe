'use client';

import { useState } from 'react';
import {
  returnReasonsFor,
  RETURN_REASON_LABELS,
  RETURN_REASONS_NEED_PHOTOS,
  type OrderDetailItem,
  type ReturnInfo,
  type ReturnReasonValue,
} from '@clowe/shared';
import { api, ApiRequestError, uploadImages } from '@/lib/api';
import { formatPaise } from '@/lib/format';


/** Return status timeline: Requested → Approved → Item received → Refunded. */
export function ReturnTimeline({ info }: { info: ReturnInfo }) {
  if (info.status === 'REJECTED') {
    return (
      <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        <span className="font-semibold">Return declined</span>
        {info.rejectionReason ? <> — {info.rejectionReason}</> : null}
        <p className="mt-1 text-red-600/80">
          Disagree? Raise a complaint from Support and our team will review it.
        </p>
      </div>
    );
  }

  const steps = [
    { key: 'REQUESTED', label: 'Requested', done: true },
    { key: 'APPROVED', label: 'Approved · pickup scheduled', done: !!info.approvedAt },
    { key: 'RECEIVED', label: 'Item received', done: !!info.receivedAt },
    { key: 'REFUNDED', label: 'Refund processed', done: info.status === 'REFUNDED' },
  ];
  return (
    <div className="mt-2 rounded-lg border border-brand-100 bg-brand-50/50 px-3 py-2.5">
      <p className="text-[11px] font-bold uppercase tracking-wide text-brand-700">Return status</p>
      <div className="mt-1.5 space-y-1">
        {steps.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span
              className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold ${
                s.done ? 'bg-brand-600 text-white' : 'border border-gray-300 bg-white text-gray-300'
              }`}
            >
              {s.done ? '✓' : ''}
            </span>
            <span className={s.done ? 'font-semibold text-ink-900' : 'text-gray-400'}>{s.label}</span>
          </div>
        ))}
      </div>
      {info.refund && (
        <p className="mt-2 border-t border-brand-100 pt-1.5 text-xs text-gray-600">
          {info.refund.status === 'PROCESSED' ? (
            <>
              💸 <span className="font-semibold">{formatPaise(info.refund.amountPaise)} refunded</span> — it
              should reflect in your account within 5–7 business days.
            </>
          ) : (
            <>
              💰 Refund of <span className="font-semibold">{formatPaise(info.refund.amountPaise)}</span>{' '}
              initiated — expect it within 5–7 business days.
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** Return request modal: reason + details + photos (theme card, mobile sheet). */
export function ReturnModal({
  item,
  onClose,
  onDone,
}: {
  item: OrderDetailItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState<ReturnReasonValue | ''>('');
  const [details, setDetails] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const needsPhotos = reason !== '' && RETURN_REASONS_NEED_PHOTOS.includes(reason);

  async function submit() {
    if (!reason) return;
    if (reason === 'OTHER' && details.trim().length < 5) {
      setError('Please describe the issue (min 5 characters)');
      return;
    }
    if (needsPhotos && files.length === 0) {
      setError('Please add at least one photo of the item');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const photos = files.length > 0 ? await uploadImages(files) : [];
      await api(`/api/orders/items/${item.id}/return`, {
        body: { reason, details: details.trim() || undefined, photos },
        auth: true,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:max-w-md sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-ink-900">Return item</h2>
            <p className="mt-0.5 text-xs text-gray-500">{item.title}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-xl leading-none text-gray-400 hover:bg-cream-100">
            ×
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <p className="mt-4 text-sm font-semibold text-ink-900">Why are you returning this?</p>
        <div className="mt-2 space-y-1.5">
          {returnReasonsFor(item.size !== '').map((r) => (
            <label
              key={r}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition ${
                reason === r ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="return-reason"
                checked={reason === r}
                onChange={() => setReason(r)}
                className="accent-brand-600"
              />
              {RETURN_REASON_LABELS[r]}
            </label>
          ))}
        </div>

        {reason && (
          <>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              maxLength={300}
              rows={2}
              placeholder={reason === 'OTHER' ? 'Describe the issue *' : 'Any details for the seller (optional)'}
              className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
            />

            <p className="mt-2 text-sm font-semibold text-ink-900">
              Photos {needsPhotos ? <span className="text-red-600">*</span> : <span className="font-normal text-gray-400">(optional)</span>}
              <span className="ml-1 text-xs font-normal text-gray-400">up to 3</span>
            </p>
            <div className="mt-1.5 flex gap-2">
              {files.map((f, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={URL.createObjectURL(f)} alt="" className="h-16 w-16 rounded-lg object-cover" />
                  <button
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink-900 text-xs text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
              {files.length < 3 && (
                <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-2xl text-gray-400 hover:border-brand-600 hover:text-brand-600">
                  +
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setFiles((prev) => [...prev, f].slice(0, 3));
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
          </>
        )}

        <button
          onClick={() => void submit()}
          disabled={busy || !reason}
          className="mt-5 w-full rounded-xl bg-brand-600 py-2.5 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'Submit return request'}
        </button>
      </div>
    </div>
  );
}
