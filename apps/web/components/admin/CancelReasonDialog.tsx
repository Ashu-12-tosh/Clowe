'use client';

import { useState } from 'react';
import {
  ADMIN_CANCEL_CUSTOMER_TEXT,
  ADMIN_CANCEL_REASON_LABELS,
  ADMIN_CANCEL_REASONS,
  adminCancelReasonText,
  type AdminCancelReason,
} from '@clowe/shared';

export interface CancelReasonChoice {
  reasonCode: AdminCancelReason;
  otherText?: string;
}

/**
 * Why an order (or one item) is being cancelled: a reason from the list, with
 * the exact words the customer will see. "Other" needs a short text the admin
 * writes and confirms.
 */
export default function CancelReasonDialog({
  title,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choice: CancelReasonChoice) => void;
}) {
  const [code, setCode] = useState<AdminCancelReason | ''>('');
  const [other, setOther] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const isOther = code === 'OTHER';
  const preview = code ? adminCancelReasonText({ reasonCode: code, otherText: other }) : '';
  const ready = !!code && (!isOther || (other.trim().length >= 5 && confirmed));

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 sm:items-center" role="dialog" aria-modal="true" aria-label={title} data-cancel-dialog>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
        <h2 className="text-base font-bold text-ink-900">{title}</h2>
        <label className="mt-3 block text-sm font-medium text-ink-900">
          Reason
          <select
            name="cancelReasonCode"
            value={code}
            onChange={(e) => {
              setCode(e.target.value as AdminCancelReason);
              setConfirmed(false);
            }}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            <option value="">Pick a reason…</option>
            {ADMIN_CANCEL_REASONS.map((r) => (
              <option key={r} value={r}>
                {ADMIN_CANCEL_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        {isOther && (
          <>
            <label className="mt-3 block text-sm font-medium text-ink-900">
              What the customer is told
              <textarea
                name="cancelOtherText"
                value={other}
                maxLength={200}
                rows={3}
                onChange={(e) => {
                  setOther(e.target.value);
                  setConfirmed(false);
                }}
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                placeholder="A short, polite sentence"
              />
            </label>
            <label className="mt-2 flex items-start gap-2 text-xs text-gray-700">
              <input type="checkbox" name="cancelConfirm" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" disabled={other.trim().length < 5} />
              I have read it: the customer will see exactly this.
            </label>
          </>
        )}
        {preview && (
          <p className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-sm text-ink-900" data-cancel-preview>
            <span className="text-xs font-semibold text-gray-500">The customer will see: </span>
            {preview}
          </p>
        )}
        {code && code !== 'OTHER' && code === 'SUSPECTED_FRAUD' && (
          <p className="mt-1 text-[11px] text-gray-500">The customer is not told it was suspected fraud: {ADMIN_CANCEL_CUSTOMER_TEXT.SUSPECTED_FRAUD}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700">
            Keep it
          </button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => code && onConfirm({ reasonCode: code, ...(isOther ? { otherText: other.trim() } : {}) })}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            data-action="confirm-cancel"
          >
            {busy ? 'Cancelling…' : 'Cancel and tell the customer'}
          </button>
        </div>
      </div>
    </div>
  );
}
