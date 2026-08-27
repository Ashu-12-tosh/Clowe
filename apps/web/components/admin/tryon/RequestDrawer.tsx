'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AdminTryOnRequestDetail, AdminTryOnRequestRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-0.5 text-sm text-ink-900">{value}</p>
    </div>
  );
}

/**
 * Side drawer for one try-on run: both images, full metadata, and the two
 * moderation actions (flag for review, take the generated image down).
 */
export default function RequestDrawer({
  requestId,
  onClose,
  onChanged,
}: {
  requestId: string;
  onClose: () => void;
  onChanged: (row: AdminTryOnRequestRow) => void;
}) {
  const [detail, setDetail] = useState<AdminTryOnRequestDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    setDetail(null);
    setError('');
    api<AdminTryOnRequestDetail>(`/api/admin/tryon/requests/${requestId}`, { auth: true })
      .then((d) => {
        setDetail(d);
        setReason(d.flagReason ?? '');
      })
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load this run'),
      );
  }, [requestId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function act(path: string, options: { method?: string; body?: unknown }) {
    setBusy(true);
    setError('');
    try {
      const row = await api<AdminTryOnRequestRow>(path, { ...options, auth: true });
      onChanged(row);
      setDetail((prev) => (prev ? { ...prev, ...row } : prev));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-900/40" onClick={onClose}>
      <aside
        className="h-full w-full max-w-lg overflow-y-auto bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4">
          <div>
            <p className="font-mono text-sm font-bold text-brand-600">
              {detail?.requestId ?? 'Loading…'}
            </p>
            <p className="text-xs text-gray-500">Try-on run detail</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full px-3 py-1 text-sm text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </header>

        {error && <p className="mx-5 mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!detail && !error && <p className="p-5 text-sm text-gray-500">Loading…</p>}

        {detail && (
          <div className="space-y-5 p-5">
            <div className="grid grid-cols-2 gap-3">
              <figure>
                <figcaption className="mb-1 text-[11px] uppercase tracking-wide text-gray-400">
                  Input photo
                </figcaption>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={detail.inputImageUrl}
                  alt="Shopper input"
                  className="aspect-[3/4] w-full rounded-xl border border-gray-200 object-cover"
                />
              </figure>
              <figure>
                <figcaption className="mb-1 text-[11px] uppercase tracking-wide text-gray-400">
                  Generated result
                </figcaption>
                {detail.resultImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={detail.resultImageUrl}
                    alt="Try-on result"
                    className="aspect-[3/4] w-full rounded-xl border border-gray-200 object-cover"
                  />
                ) : (
                  <div className="flex aspect-[3/4] w-full items-center justify-center rounded-xl border border-dashed border-gray-300 bg-cream-50 px-3 text-center text-xs text-gray-400">
                    {detail.status === 'FAILED' ? 'Generation failed' : 'No result image'}
                  </div>
                )}
              </figure>
            </div>

            {detail.errorMessage && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                <span className="font-semibold">Error:</span> {detail.errorMessage}
              </p>
            )}

            <div className="grid grid-cols-2 gap-4 rounded-2xl border border-gray-100 p-4">
              <Field label="Status" value={detail.status} />
              <Field label="Model / provider" value={detail.provider} />
              <Field
                label="Generation time"
                value={detail.durationMs != null ? `${(detail.durationMs / 1000).toFixed(2)}s` : '—'}
              />
              <Field label="Logged cost" value={formatPaise(detail.costPaise)} />
              <Field label="Device" value={detail.deviceType ?? '—'} />
              <Field
                label="Fit rating"
                value={detail.feedback === 'UP' ? '👍 Happy' : detail.feedback === 'DOWN' ? '👎 Poor fit' : 'Not rated'}
              />
              <Field
                label="Variant"
                value={[detail.variantSize, detail.variantColor].filter(Boolean).join(' · ') || '—'}
              />
              <Field label="Requested on" value={new Date(detail.createdAt).toLocaleString('en-IN')} />
            </div>

            <div className="rounded-2xl border border-gray-100 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">Shopper</h3>
              <p className="mt-1 text-sm font-semibold text-ink-900">
                {detail.userName ?? 'Unnamed'}{' '}
                <span className="font-normal text-gray-500">· +91 {detail.userPhone}</span>
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {detail.userEmail ?? 'No email'} · joined{' '}
                {new Date(detail.userJoinedAt).toLocaleDateString('en-IN')} ·{' '}
                {detail.userTotalTryOns} try-ons all time
              </p>
            </div>

            <div className="rounded-2xl border border-gray-100 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">Product</h3>
              <p className="mt-1 text-sm font-semibold text-ink-900">{detail.productTitle}</p>
              <p className="mt-0.5 text-xs text-gray-500">
                {detail.productBrand ?? 'No brand'} · {detail.categoryName} ·{' '}
                {formatPaise(detail.productPricePaise)}
                {detail.sellerShopName && <> · sold by {detail.sellerShopName}</>}
              </p>
              <Link
                href={`/products/${detail.productSlug}`}
                className="mt-2 inline-block text-xs font-semibold text-brand-600 hover:underline"
              >
                View in store →
              </Link>
            </div>

            <div className="rounded-2xl border border-gray-100 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Moderation
              </h3>
              {detail.flagged ? (
                <p className="mt-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  🚩 Flagged — {detail.flagReason}
                </p>
              ) : (
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason for flagging (optional)"
                  className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
                />
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {detail.flagged ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(`/api/admin/tryon/requests/${detail.id}/flag`, {
                        body: { flagged: false },
                      })
                    }
                    className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-50 disabled:opacity-50"
                  >
                    Clear flag
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(`/api/admin/tryon/requests/${detail.id}/flag`, {
                        body: { flagged: true, reason: reason.trim() || undefined },
                      })
                    }
                    className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                  >
                    🚩 Flag for review
                  </button>
                )}
                {detail.resultImageUrl && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (!confirm('Delete the generated image for this run? This cannot be undone.')) return;
                      void act(`/api/admin/tryon/requests/${detail.id}/result`, { method: 'DELETE' });
                    }}
                    className="rounded-lg border border-red-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    Remove result image
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
