'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  PACKING_VIDEO_MAX_BYTES,
  PACKING_VIDEO_MAX_SECONDS,
  PACKING_VIDEO_RETENTION_DAYS,
  type PackingVideoView,
} from '@clowe/shared';
import { api, ApiRequestError, uploadVideo } from '@/lib/api';
import Spinner from '@/components/Spinner';

type Stage = 'idle' | 'starting' | 'live' | 'recording' | 'review' | 'uploading';

/** The phone's back camera faces the parcel; a laptop's front camera faces the desk. */
function isPhone(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

/** The first recording format this browser supports: WebM (Chrome, Firefox, Android) or MP4 (Safari). */
function recorderType(): string {
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  return types.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) ?? '';
}

/** What went wrong with the camera, in the seller's words. */
function cameraProblem(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was denied. Allow camera access for this site in your browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'No camera was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is busy in another app. Close it there, then try again.';
  }
  return 'The camera could not be started.';
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * The order's packing video: required before anything ships, and recorded
 * right here with the device's camera — the back camera on a phone, the front
 * one on a laptop. It stops itself at a minute (or 40 MB), and the seller
 * watches it back before it is used. There is no file upload: the clip is
 * evidence of this packing, so it has to be filmed now. Private to the seller
 * and Clowe's team — the buyer never sees it.
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
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState('');
  const [cameraBlocked, setCameraBlocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<{ blob: Blob; url: string; type: string } | null>(null);
  const liveRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const present = video !== null && !video.deleted;

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // Leaving the page turns the camera off and frees the recording.
  useEffect(
    () => () => {
      stopCamera();
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    },
    [],
  );
  useEffect(() => () => {
    if (take) URL.revokeObjectURL(take.url);
  }, [take]);

  // The live picture follows the stream once the <video> is on screen.
  useEffect(() => {
    if ((stage === 'live' || stage === 'recording') && liveRef.current && streamRef.current) {
      liveRef.current.srcObject = streamRef.current;
    }
  }, [stage]);

  async function openCamera() {
    setError('');
    setCameraBlocked(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || !recorderType()) {
      setCameraBlocked(true);
      setError('This browser can’t record video. Open this page in Chrome, Safari or Firefox on your phone or computer.');
      return;
    }
    setStage('starting');
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: isPhone() ? 'environment' : 'user' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      setStage('live');
    } catch (err) {
      setStage('idle');
      setCameraBlocked(true);
      setError(cameraProblem(err));
    }
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    const type = recorderType();
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_000_000 });
    recorderRef.current = recorder;
    const chunks: Blob[] = [];
    let bytes = 0;
    const started = Date.now();
    const ticker = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setElapsed(s);
      if (s >= PACKING_VIDEO_MAX_SECONDS && recorder.state === 'recording') recorder.stop();
    }, 250);
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      chunks.push(e.data);
      bytes += e.data.size;
      if (bytes >= PACKING_VIDEO_MAX_BYTES && recorder.state === 'recording') recorder.stop();
    };
    recorder.onstop = () => {
      clearInterval(ticker);
      stopCamera();
      const base = type.split(';')[0]!;
      const blob = new Blob(chunks, { type: base });
      setTake({ blob, url: URL.createObjectURL(blob), type: base });
      setStage('review');
    };
    setElapsed(0);
    recorder.start(1000);
    setStage('recording');
  }

  function stopRecording() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  function retake() {
    setTake(null);
    void openCamera();
  }

  function cancel() {
    stopCamera();
    setTake(null);
    setStage('idle');
  }

  async function saveTake() {
    if (!take || stage === 'uploading') return;
    setStage('uploading');
    setError('');
    try {
      const ext = take.type === 'video/mp4' ? 'mp4' : 'webm';
      const uploaded = await uploadVideo(new File([take.blob], `packing-${orderId}.${ext}`, { type: take.type }));
      const saved = await api<PackingVideoView>(`/api/seller/orders/${orderId}/packing-video`, {
        method: 'POST',
        body: { ref: uploaded.ref },
        auth: true,
        success: 'Packing video saved',
      });
      setTake(null);
      setStage('idle');
      onChange(saved);
    } catch (err) {
      setStage('review');
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed — try again');
    }
  }

  const button = 'rounded-lg px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide disabled:opacity-50';
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
                : 'Film the items going into the box, label visible — up to a minute. It settles a disputed return.'}{' '}
            Only you and Clowe&apos;s team can see it — never the buyer. Kept {PACKING_VIDEO_RETENTION_DAYS} days after
            delivery, longer while a return is open.
          </p>
        </div>
        {!locked && stage === 'idle' && (
          <button type="button" onClick={() => void openCamera()} className={`${button} bg-ink-900 text-white hover:bg-ink-800`}>
            {present ? 'Re-record' : 'Record video'}
          </button>
        )}
        {stage === 'starting' && <p className="text-xs font-semibold text-gray-500">Starting the camera…</p>}
      </div>

      {(stage === 'live' || stage === 'recording') && (
        <div className="mt-3 max-w-md">
          <div className="relative overflow-hidden rounded-lg bg-black">
            <video ref={liveRef} autoPlay muted playsInline className="max-h-72 w-full object-contain" />
            {stage === 'recording' && (
              <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 text-xs font-semibold text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                {clock(elapsed)} / {clock(PACKING_VIDEO_MAX_SECONDS)}
              </span>
            )}
          </div>
          <div className="mt-2 flex gap-2">
            {stage === 'live' ? (
              <button type="button" onClick={startRecording} className={`${button} bg-red-600 text-white hover:bg-red-700`}>
                ● Start recording
              </button>
            ) : (
              <button type="button" onClick={stopRecording} className={`${button} bg-ink-900 text-white hover:bg-ink-800`}>
                ■ Stop
              </button>
            )}
            <button type="button" onClick={cancel} disabled={stage === 'recording'} className={`${button} border border-gray-300 bg-white hover:bg-gray-50`}>
              Cancel
            </button>
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            Stops by itself at {PACKING_VIDEO_MAX_SECONDS} seconds.
          </p>
        </div>
      )}

      {(stage === 'review' || stage === 'uploading') && take && (
        <div className="mt-3 max-w-md">
          <video src={take.url} controls playsInline className="max-h-72 w-full rounded-lg border border-gray-200 bg-black" />
          <p className="mt-1 text-[11px] text-gray-500">
            {clock(elapsed)} · {(take.blob.size / (1024 * 1024)).toFixed(1)} MB — watch it back: is the label visible?
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void saveTake()} disabled={stage === 'uploading'} className={`${button} bg-brand-600 text-white hover:bg-brand-700`}>
              {stage === 'uploading' ? <><Spinner className="mr-1" />Saving…</> : 'Use this video'}
            </button>
            <button type="button" onClick={retake} disabled={stage === 'uploading'} className={`${button} border border-gray-300 bg-white hover:bg-gray-50`}>
              Retake
            </button>
          </div>
        </div>
      )}

      {present && video!.url && stage === 'idle' && (
        <video src={video!.url} controls className="mt-3 max-h-60 w-full max-w-md rounded-lg border border-gray-200 bg-black" />
      )}

      {error && (
        <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
          <p>{error}</p>
          {cameraBlocked && (
            <p className="mt-1">
              Can&apos;t record on any of your devices?{' '}
              <Link href="/seller/support" className="font-semibold underline">
                Ask Clowe support
              </Link>{' '}
              — an admin can mark the order packed or shipped without the video, with the reason on record.
            </p>
          )}
        </div>
      )}
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
