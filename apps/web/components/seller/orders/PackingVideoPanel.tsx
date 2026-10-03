'use client';

import { useState } from 'react';
import { PACKING_VIDEO_RETENTION_DAYS, type PackingVideoView } from '@clowe/shared';
import { api, ApiRequestError, uploadVideo } from '@/lib/api';

/**
 * The order's packing video: required before anything ships, recorded or
 * uploaded here. Private to the seller and Clowe's team — the buyer never
 * sees it — and kept until 45 days after delivery and while a return is open.
 */
export function PackingVideoPanel({
  orderId,
  video,
  locked,
  onChange,
}: {
  orderId: string;
  video: PackingVideoView | null;
  /** Something has shipped: the clip is the record now, and cannot be replaced. */
  locked: boolean;
  onChange: (video: PackingVideoView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const present = video !== null && !video.deleted;

  async function upload(file: File | null) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const uploaded = await uploadVideo(file);
      const saved = await api<PackingVideoView>(`/api/seller/orders/${orderId}/packing-video`, {
        method: 'POST',
        body: { ref: uploaded.ref },
        auth: true,
      });
      onChange(saved);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed — try again');
    } finally {
      setBusy(false);
    }
  }

  const button = 'cursor-pointer rounded-lg px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide';
  return (
    <div
      className={`rounded-2xl border p-4 ${present ? 'border-gray-100 bg-white' : 'border-amber-300 bg-amber-50'}`}
      data-packing-video={present ? 'present' : 'missing'}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink-900">
            🎥 Packing video {present ? '' : '— needed before you pack or ship'}
          </p>
          <p className="mt-0.5 text-xs text-gray-600">
            {present
              ? `Recorded ${new Date(video!.uploadedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.`
              : video?.deleted
                ? 'The clip was removed when its retention ended.'
                : 'Record the items going into the box, label visible. It settles a disputed return.'}{' '}
            Only you and Clowe&apos;s team can see it — never the buyer. Kept {PACKING_VIDEO_RETENTION_DAYS} days after
            delivery, longer while a return is open.
          </p>
        </div>
        {!locked && (
          <div className="flex flex-wrap gap-2">
            {/* capture opens the camera straight away on a phone. */}
            <label className={`${button} bg-ink-900 text-white hover:bg-ink-800 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
              {busy ? 'Uploading…' : present ? 'Re-record' : 'Record video'}
              <input
                type="file"
                accept="video/*"
                capture="environment"
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  void upload(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
            </label>
            <label className={`${button} border border-gray-300 bg-white text-ink-900 hover:bg-gray-50 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
              Upload a file
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  void upload(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        )}
      </div>
      {present && video!.url && (
        <video src={video!.url} controls className="mt-3 max-h-60 w-full max-w-md rounded-lg border border-gray-200 bg-black" />
      )}
      <p className="mt-2 text-[11px] text-gray-400">MP4, WebM or MOV, up to 50 MB.</p>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** A packing clip on a return or dispute: what went into the box. */
export function PackingVideoEvidence({ video }: { video: PackingVideoView | null | undefined }) {
  return (
    <div data-packing-evidence>
      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Packing video</p>
      {video && !video.deleted && video.url ? (
        <>
          <video src={video.url} controls className="mt-1.5 max-h-56 w-full max-w-md rounded-lg border border-gray-200 bg-black" />
          <p className="mt-1 text-[11px] text-gray-400">
            Recorded {new Date(video.uploadedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} by the
            seller. Not visible to the buyer.
          </p>
        </>
      ) : (
        <p className="mt-1 text-xs text-gray-500">
          {video?.deleted ? 'Removed when its retention ended.' : 'None recorded for this order.'}
        </p>
      )}
    </div>
  );
}
