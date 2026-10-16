'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  CLAIM_REASON_LABELS,
  CLAIM_REASONS_NEED_VIDEO,
  CLAIM_WINDOW_HOURS,
  LATENT_DEFECT_DAYS,
  codRefundAccountSchema,
  type ClaimReason,
  type ClaimRemedy,
  type OrderDetailItem,
} from '@clowe/shared';
import { api, ApiRequestError, uploadPrivateImages, uploadReturnVideo } from '@/lib/api';
import { issuesToFieldErrors } from '@/lib/fieldErrors';
import { CodBankFields, type CodBank } from './ReturnBits';

/** One group of evidence photos (up to 3). */
function PhotoPicker({ label, hint, files, setFiles, name }: { label: string; hint: string; files: File[]; setFiles: (f: File[]) => void; name: string }) {
  return (
    <div className="mt-3">
      <p className="text-sm font-semibold text-ink-900">
        {label} <span className="text-red-600">*</span>
      </p>
      <p className="text-xs text-gray-500">{hint}</p>
      <div className="mt-1.5 flex gap-2">
        {files.map((f, i) => (
          <div key={i} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={URL.createObjectURL(f)} alt="" className="h-16 w-16 rounded-lg object-cover" />
            <button
              type="button"
              onClick={() => setFiles(files.filter((_, j) => j !== i))}
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink-900 text-xs text-white"
              aria-label="Remove photo"
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
              name={name}
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setFiles([...files, f].slice(0, 3));
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}

/**
 * A claim under the Return, Exchange and Refund Policy (clauses 2–3): for a
 * defective, damaged, wrong, incomplete, counterfeit or materially different
 * item — never for a change of mind, size or colour preference. Raised within
 * 48 hours of delivery (or within 7 days of noticing a hidden defect), with
 * photos of the item, its tag and barcode and the packaging and label, and an
 * unboxing video for damage, missing or wrong items. The buyer chooses an
 * identical exchange or a refund.
 */
export function ClaimModal({
  item,
  cod = false,
  onClose,
  onDone,
}: {
  item: OrderDetailItem & { claim: NonNullable<OrderDetailItem['claim']> };
  cod?: boolean;
  onClose: () => void;
  onDone: (rmaNumber: string) => void;
}) {
  const inWindow = Date.now() <= new Date(item.claim.windowEndsAt).getTime();
  const [reason, setReason] = useState<ClaimReason | ''>('');
  const [remedy, setRemedy] = useState<ClaimRemedy>(item.claim.exchangeAllowed ? 'EXCHANGE' : 'REFUND');
  const [details, setDetails] = useState('');
  const [latent, setLatent] = useState(!inWindow);
  const [noticedOn, setNoticedOn] = useState('');
  const [itemPhotos, setItemPhotos] = useState<File[]>([]);
  const [tagPhotos, setTagPhotos] = useState<File[]>([]);
  const [packPhotos, setPackPhotos] = useState<File[]>([]);
  const [video, setVideo] = useState<File | null>(null);
  const [bank, setBank] = useState<CodBank>({ accountName: '', accountNumber: '', ifsc: '', ownAccount: false });
  const [bankErrors, setBankErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // After 48 hours only a hidden defect can be claimed (3.3).
  const reasons = inWindow ? item.claim.reasons : item.claim.reasons.filter((r) => r === 'DEFECTIVE');
  const needsVideo = reason !== '' && CLAIM_REASONS_NEED_VIDEO.includes(reason);
  const refundOnly = reason === 'DEFECTIVE' && !item.claim.exchangeAllowed;

  async function submit() {
    if (!reason) return;
    const missing =
      itemPhotos.length === 0
        ? 'Add a photo of the item showing the problem'
        : tagPhotos.length === 0
          ? 'Add a photo of the brand tag and barcode'
          : packPhotos.length === 0
            ? 'Add a photo of the outer packaging and shipping label'
            : needsVideo && !video
              ? 'Add your unboxing video — it is needed for damaged, missing or wrong items'
              : latent && reason === 'DEFECTIVE' && !noticedOn
                ? 'Say when you noticed the defect'
                : '';
    if (missing) {
      setError(missing);
      return;
    }
    let codRefundAccount: unknown;
    if (cod) {
      const checked = codRefundAccountSchema.safeParse(bank);
      if (!checked.success) {
        setBankErrors(issuesToFieldErrors(checked.error.issues));
        setError('Check the bank details for a refund');
        return;
      }
      setBankErrors({});
      codRefundAccount = checked.data;
    }
    setError('');
    setBusy(true);
    try {
      const [photos, tags, packaging] = await Promise.all(
        [itemPhotos, tagPhotos, packPhotos].map(async (files) => (await uploadPrivateImages(files, 'RETURN_PHOTO')).map((p) => p.ref)),
      );
      const unboxingVideo = video ? (await uploadReturnVideo(video)).ref : undefined;
      const result = await api<{ rmaNumber: string }>(`/api/orders/items/${item.id}/return`, {
        auth: true,
        quiet: true,
        body: {
          reason,
          remedy: refundOnly ? 'REFUND' : remedy,
          details: details.trim() || undefined,
          photos,
          tagPhotos: tags,
          packagingPhotos: packaging,
          unboxingVideo,
          latentNoticedAt: latent && reason === 'DEFECTIVE' && noticedOn ? new Date(`${noticedOn}T12:00:00+05:30`).toISOString() : undefined,
          codRefundAccount,
        },
      });
      onDone(result.rmaNumber);
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
        role="dialog"
        aria-label="Report a problem with this item"
        data-claim-modal
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-ink-900">Report a problem</h2>
            <p className="mt-0.5 text-xs text-gray-500">{item.title}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-xl leading-none text-gray-400 hover:bg-cream-100" aria-label="Close">
            ×
          </button>
        </div>

        <p className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-xs text-gray-600">
          We exchange or refund items that arrive defective, damaged, wrong, incomplete, counterfeit or not as described —
          not for a change of mind, fit or colour preference.{' '}
          {inWindow
            ? `Claims are raised within ${CLAIM_WINDOW_HOURS} hours of delivery.`
            : `The ${CLAIM_WINDOW_HOURS}-hour window has passed: you can still report a hidden defect within ${LATENT_DEFECT_DAYS} days of noticing it.`}{' '}
          <Link href="/pages/return-policy" className="font-semibold text-brand-600 hover:underline">
            Return Policy
          </Link>
        </p>

        {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <p className="mt-4 text-sm font-semibold text-ink-900">What is wrong with it?</p>
        <div className="mt-2 space-y-1.5">
          {reasons.map((r) => (
            <label
              key={r}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition ${
                reason === r ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <input type="radio" name="claim-reason" checked={reason === r} onChange={() => setReason(r)} className="accent-brand-600" />
              {CLAIM_REASON_LABELS[r]}
            </label>
          ))}
        </div>
        {!item.returnable && (
          <p className="mt-2 text-xs text-gray-500">This item is not returnable, so only a wrong, counterfeit or non-conforming item can be claimed.</p>
        )}

        {reason && (
          <>
            {reason === 'DEFECTIVE' && (
              <div className="mt-3">
                {inWindow && (
                  <label className="flex items-center gap-2 text-xs text-gray-700">
                    <input type="checkbox" name="latent" checked={latent} onChange={(e) => setLatent(e.target.checked)} className="accent-brand-600" />
                    The defect was hidden and showed only later
                  </label>
                )}
                {latent && (
                  <label className="mt-2 block text-xs font-semibold text-gray-700">
                    When did you notice it? <span className="text-red-600">*</span>
                    <input
                      type="date"
                      name="noticedOn"
                      value={noticedOn}
                      max={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setNoticedOn(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal outline-none focus:border-brand-600"
                    />
                  </label>
                )}
              </div>
            )}

            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              maxLength={500}
              rows={2}
              name="details"
              placeholder="Tell the seller what you found (optional)"
              className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
            />

            <PhotoPicker name="itemPhotos" label="The item" hint="Show the defect, damage or difference clearly." files={itemPhotos} setFiles={setItemPhotos} />
            <PhotoPicker name="tagPhotos" label="Brand tag and barcode" hint="The label on the item with its barcode." files={tagPhotos} setFiles={setTagPhotos} />
            <PhotoPicker name="packagingPhotos" label="Packaging and shipping label" hint="The outer box or pouch, with the courier label." files={packPhotos} setFiles={setPackPhotos} />

            <div className="mt-3">
              <p className="text-sm font-semibold text-ink-900">
                Unboxing video {needsVideo ? <span className="text-red-600">*</span> : <span className="font-normal text-gray-400">(optional)</span>}
              </p>
              <p className="text-xs text-gray-500">One continuous video from the sealed parcel. MP4, WebM or MOV, up to 50 MB.</p>
              <input
                type="file"
                name="unboxingVideo"
                accept="video/mp4,video/webm,video/quicktime"
                onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
                className="mt-1.5 block w-full text-xs"
              />
            </div>

            <p className="mt-4 text-sm font-semibold text-ink-900">What would you like?</p>
            {refundOnly ? (
              <p className="mt-1 text-xs text-gray-600">This item was already exchanged for a defect, so this time it is refunded.</p>
            ) : (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(['EXCHANGE', 'REFUND'] as const).map((m) => (
                  <label
                    key={m}
                    className={`cursor-pointer rounded-xl border px-3 py-2.5 text-sm ${
                      remedy === m ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-gray-200'
                    }`}
                  >
                    <input type="radio" name="remedy" checked={remedy === m} onChange={() => setRemedy(m)} className="mr-2 accent-brand-600" />
                    {m === 'EXCHANGE' ? 'Exchange' : 'Refund'}
                    <span className="mt-0.5 block text-[11px] font-normal text-gray-500">
                      {m === 'EXCHANGE' ? 'An identical item, free. Refunded if none is in stock.' : 'The amount you paid, to how you paid.'}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-gray-500">
              Pickup is free. Once the item passes the seller&apos;s check, the exchange ships free or the refund starts within 3 working
              days. An item found used, altered or not the one sent is returned to you.
            </p>
          </>
        )}

        {reason && cod && <CodBankFields bank={bank} setBank={setBank} errors={bankErrors} />}

        <button
          onClick={() => void submit()}
          disabled={busy || !reason}
          className="mt-5 w-full rounded-xl bg-brand-600 py-2.5 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'Submit claim'}
        </button>
      </div>
    </div>
  );
}
