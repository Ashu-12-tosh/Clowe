'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BUSINESS_TYPES,
  KYC_STATUSES,
  KYC_STATUS_LABELS,
  SELLER_STATUS_LABELS,
  type AdminSellerDetail,
  type AdminSellerStatus,
  type KycStatus,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

export const SELLER_STATUS_STYLES: Record<AdminSellerStatus, string> = {
  APPROVED: 'bg-green-100 text-green-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
  REJECTED: 'bg-red-100 text-red-700',
  SUSPENDED: 'bg-orange-100 text-orange-700',
  BANNED: 'bg-red-100 text-red-700',
};

export const KYC_STYLES: Record<KycStatus, string> = {
  VERIFIED: 'bg-green-100 text-green-700',
  UNDER_REVIEW: 'bg-blue-100 text-blue-700',
  PENDING_DOCS: 'bg-yellow-100 text-yellow-700',
  REJECTED: 'bg-red-100 text-red-700',
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 text-right text-ink-900">{value}</dd>
    </div>
  );
}

type Tab = 'OVERVIEW' | 'PERFORMANCE' | 'ORDERS' | 'NOTES';

export default function SellerDetailPanel({
  sellerId,
  onClose,
  onChanged,
}: {
  sellerId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<AdminSellerDetail | null>(null);
  const [tab, setTab] = useState<Tab>('OVERVIEW');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setDetail(await api<AdminSellerDetail>(`/api/admin/sellers/${sellerId}`, { auth: true }));
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load this seller');
    }
  }, [sellerId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function act(action: 'approve' | 'reject' | 'suspend' | 'ban' | 'reinstate') {
    let body: Record<string, unknown> = { action };
    if (action !== 'approve' && action !== 'reinstate') {
      const reason = prompt(
        `Reason for ${action === 'ban' ? 'banning' : action === 'suspend' ? 'suspending' : 'rejecting'} ${detail?.shopName}? (shown to the seller)`,
      );
      if (!reason || reason.trim().length < 5) return;
      body = { action, reason: reason.trim() };
    }
    if (action === 'ban' && !confirm(`Ban ${detail?.shopName}? Their listings go offline immediately.`)) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await api(`/api/admin/sellers/${sellerId}/status`, { method: 'PATCH', body, auth: true });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function setKyc(kycStatus: KycStatus, businessType?: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/admin/sellers/${sellerId}/kyc`, {
        method: 'PATCH',
        body: { kycStatus, ...(businessType !== undefined ? { businessType } : {}) },
        auth: true,
      });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update KYC');
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    if (note.trim().length < 3) return;
    setBusy(true);
    try {
      await api(`/api/admin/sellers/${sellerId}/notes`, {
        method: 'POST',
        body: { body: note.trim() },
        auth: true,
      });
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the note');
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
        <header className="sticky top-0 flex items-start justify-between border-b border-gray-100 bg-white px-5 py-4">
          <div className="min-w-0">
            <p className="truncate font-display text-lg font-bold text-ink-900">
              {detail?.shopName ?? 'Loading…'}
            </p>
            {detail && (
              <p className="text-xs text-gray-500">
                <span className="font-mono">{detail.sellerId}</span> · {detail.phone}
                {detail.email && <> · {detail.email}</>}
              </p>
            )}
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
          <div className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${SELLER_STATUS_STYLES[detail.status]}`}
              >
                {SELLER_STATUS_LABELS[detail.status]}
              </span>
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${KYC_STYLES[detail.kycStatus]}`}
              >
                KYC: {KYC_STATUS_LABELS[detail.kycStatus]}
              </span>
              {detail.primaryCategory && (
                <span className="rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600">
                  {detail.primaryCategory}
                </span>
              )}
            </div>

            {(detail.suspensionReason || detail.rejectionReason) && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {detail.suspensionReason ?? detail.rejectionReason}
              </p>
            )}

            <div className="mt-4 flex gap-1 border-b border-gray-100">
              {(['OVERVIEW', 'PERFORMANCE', 'ORDERS', 'NOTES'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-2 text-xs font-semibold ${
                    tab === t
                      ? 'border-b-2 border-brand-600 text-brand-600'
                      : 'text-gray-500 hover:text-ink-900'
                  }`}
                >
                  {t.charAt(0) + t.slice(1).toLowerCase()}
                  {t === 'NOTES' && detail.notes.length > 0 && (
                    <span className="ml-1 text-gray-400">({detail.notes.length})</span>
                  )}
                </button>
              ))}
            </div>

            {tab === 'OVERVIEW' && (
              <dl className="mt-3 divide-y divide-gray-50 text-xs">
                <Row label="Owner" value={detail.ownerName ?? '—'} />
                <Row
                  label="Business type"
                  value={
                    <select
                      value={detail.businessType ?? ''}
                      onChange={(e) => void setKyc(detail.kycStatus, e.target.value)}
                      disabled={busy}
                      className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs outline-none"
                    >
                      <option value="">Not set</option>
                      {BUSINESS_TYPES.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  }
                />
                <Row label="GSTIN" value={detail.gstNumber ?? '— not provided'} />
                <Row label="PAN" value={detail.panNumber ?? '— not provided'} />
                <Row
                  label="Address"
                  value={
                    detail.addressLine1
                      ? `${detail.addressLine1}, ${[detail.city, detail.state, detail.pincode].filter(Boolean).join(', ')}`
                      : '— not provided'
                  }
                />
                <Row
                  label="Bank account"
                  value={
                    detail.bankAccountNo
                      ? `${detail.bankAccountNo} · ${detail.bankIfsc ?? ''}`
                      : '— not provided'
                  }
                />
                <Row
                  label="Joined on"
                  value={new Date(detail.joinedAt).toLocaleString('en-IN', { dateStyle: 'medium' })}
                />
                <Row
                  label="KYC reviewed"
                  value={
                    detail.kycReviewedAt
                      ? new Date(detail.kycReviewedAt).toLocaleDateString('en-IN')
                      : 'Never'
                  }
                />
                <Row label="Products" value={`${detail.liveProductCount} live / ${detail.productCount}`} />
                <Row label="Orders" value={String(detail.orderCount)} />
                <Row label="GMV this month" value={formatPaise(detail.gmvMonthPaise)} />
                <Row label="GMV all time" value={formatPaise(detail.gmvTotalPaise)} />
              </dl>
            )}

            {tab === 'PERFORMANCE' && (
              <dl className="mt-3 divide-y divide-gray-50 text-xs">
                <Row label="Units sold" value={String(detail.performance.unitsSold)} />
                <Row
                  label="Return rate"
                  value={
                    <span className={detail.performance.returnRate > 10 ? 'text-red-600' : ''}>
                      {detail.performance.returnRate}%
                    </span>
                  }
                />
                <Row
                  label="Cancellation rate"
                  value={
                    <span className={detail.performance.cancelRate > 5 ? 'text-red-600' : ''}>
                      {detail.performance.cancelRate}%
                    </span>
                  }
                />
                <Row
                  label="On-time delivery"
                  value={
                    detail.performance.onTimeRate != null
                      ? `${detail.performance.onTimeRate}%`
                      : 'No delivered orders yet'
                  }
                />
                <Row
                  label="Average rating"
                  value={
                    detail.performance.avgRating != null
                      ? `${detail.performance.avgRating} ★ (${detail.performance.reviewCount} reviews)`
                      : 'No reviews yet'
                  }
                />
                <Row label="Open returns" value={String(detail.performance.openReturns)} />
                <Row label="Paid out" value={formatPaise(detail.performance.payoutsPaise)} />
              </dl>
            )}

            {tab === 'ORDERS' && (
              <div className="mt-3">
                {detail.recentOrders.length > 0 ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left uppercase tracking-wide text-gray-500">
                        <th className="pb-2 font-semibold">Order</th>
                        <th className="pb-2 font-semibold">Placed</th>
                        <th className="pb-2 font-semibold">Status</th>
                        <th className="pb-2 text-right font-semibold">Line value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.recentOrders.map((o) => (
                        <tr key={o.orderNumber} className="border-t border-gray-100">
                          <td className="py-1.5 font-mono">{o.orderNumber}</td>
                          <td className="py-1.5 text-gray-500">
                            {new Date(o.placedAt).toLocaleDateString('en-IN')}
                          </td>
                          <td className="py-1.5 text-gray-600">{o.status}</td>
                          <td className="py-1.5 text-right font-semibold">
                            {formatPaise(o.amountPaise)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-xs text-gray-400">No orders yet.</p>
                )}
              </div>
            )}

            {tab === 'NOTES' && (
              <div className="mt-3">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="Internal note — the seller never sees this."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
                />
                <button
                  onClick={() => void addNote()}
                  disabled={busy || note.trim().length < 3}
                  className="mt-2 rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                >
                  Add note
                </button>
                <ul className="mt-4 space-y-2">
                  {detail.notes.map((n) => (
                    <li key={n.id} className="rounded-xl bg-cream-50 p-3 text-xs">
                      <p className="text-ink-900">{n.body}</p>
                      <p className="mt-1 text-[11px] text-gray-400">
                        {n.authorName ?? 'Admin'} ·{' '}
                        {new Date(n.createdAt).toLocaleString('en-IN', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </p>
                    </li>
                  ))}
                  {detail.notes.length === 0 && (
                    <li className="text-xs text-gray-400">No notes yet.</li>
                  )}
                </ul>
              </div>
            )}

            {/* --- Actions ------------------------------------------------ */}
            <div className="mt-5 border-t border-gray-100 pt-4">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500">KYC review</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {KYC_STATUSES.map((k) => (
                  <button
                    key={k}
                    onClick={() => void setKyc(k)}
                    disabled={busy || detail.kycStatus === k}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-40 ${
                      detail.kycStatus === k
                        ? 'border-brand-600 text-brand-600'
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {KYC_STATUS_LABELS[k]}
                  </button>
                ))}
              </div>

              <p className="mt-4 text-xs font-bold uppercase tracking-wide text-gray-500">
                Account actions
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {detail.status === 'PENDING' && (
                  <>
                    <button
                      onClick={() => void act('approve')}
                      disabled={busy}
                      className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                    >
                      ✓ Approve
                    </button>
                    <button
                      onClick={() => void act('reject')}
                      disabled={busy}
                      className="rounded-lg border border-red-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      ✕ Reject
                    </button>
                  </>
                )}
                {detail.status === 'APPROVED' && (
                  <>
                    <button
                      onClick={() => void act('suspend')}
                      disabled={busy}
                      className="rounded-lg border border-orange-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-orange-600 hover:bg-orange-50 disabled:opacity-50"
                    >
                      ⏸ Suspend
                    </button>
                    <button
                      onClick={() => void act('ban')}
                      disabled={busy}
                      className="rounded-lg border border-red-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      ⊘ Ban
                    </button>
                  </>
                )}
                {(detail.status === 'SUSPENDED' ||
                  detail.status === 'BANNED' ||
                  detail.status === 'REJECTED') && (
                  <button
                    onClick={() => void act('reinstate')}
                    disabled={busy}
                    className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                  >
                    ↻ Reinstate
                  </button>
                )}
                <Link
                  href={`/admin/products?seller=${detail.id}`}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
                >
                  📦 Their products
                </Link>
              </div>
              <p className="mt-2 text-[11px] text-gray-400">
                Suspending or banning hides every live listing from the storefront immediately;
                reinstating brings them back.
              </p>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
