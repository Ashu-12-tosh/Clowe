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
import { toast } from '@/lib/toast';
import Spinner from '@/components/Spinner';
import { formatPaise } from '@/lib/format';
import SellerKycPanel, { KycFraudBanner, openSellerDocument } from './SellerKycPanel';
import OnboardingExceptionPanel from './OnboardingExceptionPanel';
import SellerLedgerTab from './SellerLedgerTab';
import { ExternalLink } from '@/components/ExternalLink';

/** What each account action says when it goes through. */
const DONE = {
  approve: 'Seller approved',
  reject: 'Seller rejected',
  suspend: 'Seller suspended',
  ban: 'Seller banned',
  reinstate: 'Seller reinstated',
} as const;

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

type Tab = 'OVERVIEW' | 'PERFORMANCE' | 'ORDERS' | 'LEDGER' | 'NOTES';

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
  // The action running, so its own button can say so: 'approve', 'kyc:VERIFIED', 'note'…
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  /** Why the last approve / reject / suspend / ban / reinstate was refused, shown by the buttons. */
  const [actionError, setActionError] = useState('');

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

  /** Send the seller's pickup address to Delhivery again. */
  async function retryWarehouse() {
    if (busy) return;
    setBusy('warehouse');
    setError('');
    try {
      const result = await api<{ status: string; error: string | null }>(
        `/api/admin/sellers/${sellerId}/courier-warehouse`,
        { method: 'POST', auth: true },
      );
      if (result.status === 'ACTIVE') toast.success('Pickup address registered with Delhivery');
      else toast.error(`Not registered: ${result.error ?? 'Delhivery refused the address'}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not register the pickup address');
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** The admin's VIP flag: no handling fee on new orders. */
  async function toggleVip() {
    if (!detail || busy) return;
    setBusy('vip');
    try {
      await api(`/api/admin/sellers/${sellerId}/vip`, { method: 'PATCH', auth: true, body: { vip: !detail.vip }, success: detail.vip ? 'VIP removed' : 'VIP set' });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not change the VIP flag');
    } finally {
      setBusy(null);
    }
  }

  /** An admin penalty (owner's Batch 2), with the reason the seller sees; deducted from payout. */
  async function penalise(kind: 'COUNTERFEIT_LISTING' | 'INACCURATE_TRYON_DATA') {
    const what = kind === 'COUNTERFEIT_LISTING' ? 'a counterfeit or non-compliant listing' : 'inaccurate try-on data';
    const reason = prompt(`Penalty for ${what} on ${detail?.shopName}. Reason (shown to the seller):`);
    if (!reason || reason.trim().length < 5 || busy) return;
    setBusy(`penalty:${kind}`);
    try {
      await api(`/api/admin/sellers/${sellerId}/penalties`, { auth: true, body: { kind, reason: reason.trim() }, success: 'Penalty applied — deducted from the next payout' });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not apply the penalty');
    } finally {
      setBusy(null);
    }
  }

  /** Try-on credits above the biggest pack, asked for through vendor support. */
  async function addTryOnCredits() {
    const n = Number(prompt(`How many AI Try-On credits for ${detail?.shopName}?`));
    if (!Number.isInteger(n) || n < 1 || busy) return;
    const charge = confirm(`Charge ${n} credits at the per-credit rate (+ GST) to ${detail?.shopName}'s wallet? Cancel adds them free.`);
    const note = prompt('Note (optional, shown to the seller):') ?? '';
    setBusy('tryon-credits');
    try {
      await api(`/api/admin/sellers/${sellerId}/tryon-credits`, { auth: true, body: { credits: n, charge, note: note.trim() }, success: `${n} try-on credits added` });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not add the credits');
    } finally {
      setBusy(null);
    }
  }

  /** "Needs more info": the applicant is told what to send (app, SMS, e-mail). */
  async function requestInfo() {
    const message = prompt(`What does ${detail?.shopName} need to send? (shown to the seller)`);
    if (!message || message.trim().length < 5 || busy) return;
    setBusy('request-info');
    setActionError('');
    try {
      await api(`/api/admin/sellers/${sellerId}/request-info`, { auth: true, body: { message: message.trim() }, success: 'Asked the seller for more' });
      await load();
      onChanged();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not send the request');
    } finally {
      setBusy(null);
    }
  }

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

    if (busy) return;
    setBusy(action);
    setActionError('');
    const success = DONE[action];
    try {
      try {
        // Quiet: a KYC warning is a question for the admin, not a failure; any
        // other refusal is shown by the buttons below (and toasted there).
        await api(`/api/admin/sellers/${sellerId}/status`, { method: 'PATCH', body, auth: true, success, quiet: true });
      } catch (err) {
        // KYC problems outstanding: the server refuses with each one spelled
        // out as it stands now. Approving past them is the admin's call, made
        // with that list in front of them, and it is kept in the notes.
        if (!(err instanceof ApiRequestError && err.code === 'KYC_WARNINGS_UNACKNOWLEDGED')) throw err;
        const go = confirm(
          `${err.message}\n\nApprove ${detail?.shopName} anyway? This list is saved to the seller's notes.`,
        );
        if (!go) return;
        await api(`/api/admin/sellers/${sellerId}/status`, {
          method: 'PATCH',
          body: { ...body, acknowledgeKycWarnings: true },
          auth: true,
          success,
          quiet: true,
        });
      }
      await load();
      onChanged();
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Action failed';
      setActionError(message);
      toast.error(`Not ${success.replace('Seller ', '')}: ${message}`);
    } finally {
      setBusy(null);
    }
  }

  async function setKyc(kycStatus: KycStatus, businessType?: string) {
    if (busy) return;
    setBusy(businessType !== undefined ? 'businessType' : `kyc:${kycStatus}`);
    setError('');
    try {
      await api(`/api/admin/sellers/${sellerId}/kyc`, {
        method: 'PATCH',
        body: { kycStatus, ...(businessType !== undefined ? { businessType } : {}) },
        auth: true,
        success: businessType !== undefined ? 'Business type saved' : `KYC set to ${KYC_STATUS_LABELS[kycStatus]}`,
      });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update KYC');
    } finally {
      setBusy(null);
    }
  }

  async function addNote() {
    if (note.trim().length < 3 || busy) return;
    setBusy('note');
    try {
      await api(`/api/admin/sellers/${sellerId}/notes`, {
        method: 'POST',
        body: { body: note.trim() },
        auth: true,
        success: 'Note added',
      });
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the note');
    } finally {
      setBusy(null);
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
            <p className="break-words font-display text-lg font-bold text-ink-900">
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
            <OnboardingExceptionPanel
              sellerId={detail.id}
              view={detail.onboardingException}
              onChanged={async () => {
                await load();
                onChanged();
              }}
            />
            {detail.addressMissing && (
              <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-address-missing>
                ⚠ <strong>No business address.</strong> The &quot;Sold by&quot; box on product pages must show it, so this
                seller&apos;s listings and store page are hidden from shoppers until the address line, city, state and
                PIN code are filled in Store Settings.
              </p>
            )}
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

            <KycFraudBanner kyc={detail.kyc} />

            <div className="mt-4 flex gap-1 border-b border-gray-100">
              {(['OVERVIEW', 'PERFORMANCE', 'ORDERS', 'LEDGER', 'NOTES'] as Tab[]).map((t) => (
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
              <SellerKycPanel
                sellerId={detail.id}
                onChanged={async () => {
                  await load();
                  onChanged();
                }}
              />
            )}

            {tab === 'OVERVIEW' && (
              <dl className="mt-3 divide-y divide-gray-50 text-xs">
                <Row label="Owner" value={detail.ownerName ?? '—'} />
                <Row
                  label="Business type"
                  value={
                    <select
                      value={detail.businessType ?? ''}
                      onChange={(e) => void setKyc(detail.kycStatus, e.target.value)}
                      disabled={!!busy}
                      aria-busy={busy === 'businessType'}
                      className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs outline-none disabled:opacity-60"
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
                <Row
                  label="Delhivery pickup address"
                  value={
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      <span
                        className={
                          detail.courierWarehouse.status === 'ACTIVE'
                            ? 'font-semibold text-green-700'
                            : detail.courierWarehouse.status === 'FAILED'
                              ? 'font-semibold text-red-600'
                              : 'text-gray-500'
                        }
                        title={detail.courierWarehouse.error ?? detail.courierWarehouse.name ?? undefined}
                      >
                        {detail.courierWarehouse.status === 'ACTIVE'
                          ? `Registered (${detail.courierWarehouse.name})`
                          : detail.courierWarehouse.status === 'FAILED'
                            ? `Failed — ${detail.courierWarehouse.error ?? 'see the address'}`
                            : 'Not registered yet'}
                      </span>
                      {detail.courierWarehouse.status !== 'ACTIVE' && (
                        <button
                          type="button"
                          disabled={!!busy}
                          aria-busy={busy === 'warehouse'}
                          onClick={() => void retryWarehouse()}
                          className="rounded-lg border border-gray-300 px-2 py-0.5 text-[11px] font-semibold hover:bg-gray-50 disabled:opacity-50"
                        >
                          {busy === 'warehouse' ? (
                            <>
                              <Spinner className="mr-1" />
                              Retrying…
                            </>
                          ) : (
                            'Retry'
                          )}
                        </button>
                      )}
                    </span>
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
                      ? `${detail.bankName ? `${detail.bankName} · ` : ''}${detail.bankAccountNo} · ${detail.bankIfsc ?? ''}`
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

            {tab === 'LEDGER' && (
              <div className="mt-3">
                <SellerLedgerTab sellerId={detail.id} />
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
                  disabled={!!busy || note.trim().length < 3}
                  aria-busy={busy === 'note'}
                  className="mt-2 rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                >
                  {busy === 'note' ? (
                    <>
                      <Spinner className="mr-1" />
                      Saving…
                    </>
                  ) : (
                    'Add note'
                  )}
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
                    disabled={!!busy || detail.kycStatus === k}
                    aria-busy={busy === `kyc:${k}`}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-40 ${
                      detail.kycStatus === k
                        ? 'border-brand-600 text-brand-600'
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {busy === `kyc:${k}` && <Spinner className="mr-1" />}
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
                      disabled={!!busy}
                      aria-busy={busy === 'approve'}
                      data-action="approve"
                      className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                    >
                      {busy === 'approve' ? <><Spinner className="mr-1" />Approving…</> : '✓ Approve'}
                    </button>
                    <button
                      onClick={() => void act('reject')}
                      disabled={!!busy}
                      aria-busy={busy === 'reject'}
                      data-action="reject"
                      className="rounded-lg border border-red-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {busy === 'reject' ? <><Spinner className="mr-1" />Rejecting…</> : '✕ Reject'}
                    </button>
                    {detail.status === 'PENDING' && (
                      <button
                        onClick={() => void requestInfo()}
                        disabled={!!busy}
                        data-action="request-info"
                        className="rounded-lg border border-amber-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                      >
                        {busy === 'request-info' ? <><Spinner className="mr-1" />Asking…</> : '? Needs more info'}
                      </button>
                    )}
                  </>
                )}
                {detail.status === 'APPROVED' && (
                  <>
                    <button
                      onClick={() => void act('suspend')}
                      disabled={!!busy}
                      aria-busy={busy === 'suspend'}
                      data-action="suspend"
                      className="rounded-lg border border-orange-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-orange-600 hover:bg-orange-50 disabled:opacity-50"
                    >
                      {busy === 'suspend' ? <><Spinner className="mr-1" />Suspending…</> : '⏸ Suspend'}
                    </button>
                    <button
                      onClick={() => void act('ban')}
                      disabled={!!busy}
                      aria-busy={busy === 'ban'}
                      data-action="ban"
                      className="rounded-lg border border-red-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {busy === 'ban' ? <><Spinner className="mr-1" />Banning…</> : '⊘ Ban'}
                    </button>
                  </>
                )}
                {(detail.status === 'SUSPENDED' ||
                  detail.status === 'BANNED' ||
                  detail.status === 'REJECTED') && (
                  <button
                    onClick={() => void act('reinstate')}
                    disabled={!!busy}
                    aria-busy={busy === 'reinstate'}
                    data-action="reinstate"
                    className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                  >
                    {busy === 'reinstate' ? <><Spinner className="mr-1" />Reinstating…</> : '↻ Reinstate'}
                  </button>
                )}
                <Link
                  href={`/admin/products?seller=${detail.id}`}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-50"
                >
                  📦 Their products
                </Link>
              </div>
              {actionError && (
                <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700" data-action-error>
                  {actionError}
                </p>
              )}
              {!detail.approvedAt &&
                (detail.status === 'PENDING' || detail.status === 'REJECTED') &&
                (detail.approvalBlockers.length > 0 || detail.kycApprovalWarnings.length > 0) && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900" data-approval-box>
                    <p className="font-semibold">Approving this seller means accepting:</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {detail.approvalBlockers.map((b) => (
                        <li key={b} className="font-semibold text-red-700">
                          Blocks approval: {b}
                        </li>
                      ))}
                      {detail.kycApprovalWarnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]" data-commercial-actions>
                <span className="rounded bg-cream-100 px-2 py-1 font-semibold text-ink-900">Plan: {detail.plan}</span>
                <label className="flex items-center gap-1.5 font-semibold text-gray-700">
                  <input type="checkbox" name="vip" checked={detail.vip} onChange={() => void toggleVip()} disabled={!!busy} />
                  VIP (no handling fee)
                </label>
                <button onClick={() => void penalise('COUNTERFEIT_LISTING')} disabled={!!busy} data-action="penalty-counterfeit" className="rounded border border-red-300 px-2 py-1 font-semibold text-red-700 disabled:opacity-50">
                  Penalty: counterfeit listing
                </button>
                <button onClick={() => void penalise('INACCURATE_TRYON_DATA')} disabled={!!busy} data-action="penalty-tryon" className="rounded border border-red-300 px-2 py-1 font-semibold text-red-700 disabled:opacity-50">
                  Penalty: inaccurate try-on data
                </button>
                <button onClick={() => void addTryOnCredits()} disabled={!!busy} data-action="tryon-credits" className="rounded border border-gray-300 px-2 py-1 font-semibold text-ink-900 disabled:opacity-50">
                  Add try-on credits
                </button>
              </div>
              <div className="mt-3 rounded-lg border border-gray-200 p-3 text-[11px]" data-application>
                <p className="font-semibold text-ink-900">
                  Application {detail.application.applicationId}
                  {detail.application.submittedAt && (
                    <span className="font-normal text-gray-500"> · submitted {new Date(detail.application.submittedAt).toLocaleDateString('en-IN')}</span>
                  )}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {detail.application.documents.map((d) => (
                    <li key={d.key}>
                      {d.label}:{' '}
                      {d.onFile ? (
                        <button
                          type="button"
                          onClick={() =>
                            void openSellerDocument(`/api/admin/sellers/${detail.id}/documents/${d.key}/view`).catch((err) =>
                              setError(err instanceof ApiRequestError ? err.message : 'Could not open the document'),
                            )
                          }
                          className="font-semibold text-brand-600 underline"
                        >
                          open
                        </button>
                      ) : (
                        <span className="text-gray-400">not given</span>
                      )}
                      {d.key === 'signatoryKycDoc' && d.onFile && (
                        <span className="ml-1 text-amber-700">— if it is an Aadhaar, check it is masked (last 4 digits only)</span>
                      )}
                    </li>
                  ))}
                </ul>
                {detail.application.infoRequest && (
                  <p className="mt-1 text-amber-800">Asked for more: {detail.application.infoRequest}</p>
                )}
                <p className="mt-1 text-gray-500">
                  Vendor Terms: {detail.application.vendorTermsCurrent ? 'current version accepted' : 'current version NOT accepted yet'}
                  {detail.application.termsAcceptances[0] &&
                    ` — last ${detail.application.termsAcceptances[0].version} on ${new Date(detail.application.termsAcceptances[0].acceptedAt).toLocaleString('en-IN')}${
                      detail.application.termsAcceptances[0].ip ? ` from ${detail.application.termsAcceptances[0].ip}` : ''
                    }`}
                </p>
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
