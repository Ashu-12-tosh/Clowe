'use client';

/**
 * AI Try-On as a slide-in panel on the product page.
 *
 * Try-on used to be its own route, which meant leaving the product to use it
 * and coming back to buy. Here it opens over the right-hand side of the page
 * the shopper is already on, so the listing, the price and Add to Cart stay in
 * view behind it.
 *
 * The photo comes from the account — it is asked for once at sign-up and saved
 * — so the normal path is: open, press Generate. Changing it is a deliberate
 * action, not a step in the way.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  TRYON_PHOTO_MAX_BYTES,
  type ProductDetail,
  type ProductVariantInfo,
  type TryOnFeedback,
  type TryOnHistoryRow,
  type TryOnQuota,
  type TryOnResult,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser, uploadImages } from '@/lib/api';

const PHOTO_TIPS = ['Good lighting', 'Face the camera', 'Arms visible', 'Plain background'];

export default function TryOnPanel({
  product,
  variant,
  open,
  onClose,
}: {
  product: ProductDetail;
  /** The size/colour on screen, recorded with the run. */
  variant: ProductVariantInfo | null;
  open: boolean;
  onClose: () => void;
}) {
  const [quota, setQuota] = useState<TryOnQuota | null>(null);
  const [runs, setRuns] = useState<TryOnHistoryRow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const loggedIn = getStoredUser() !== null;

  const savedPhotoUrl = quota?.savedPhotoUrl ?? null;
  const current = runs.find((r) => r.id === currentId) ?? runs[0] ?? null;

  const loadRuns = useCallback(() => {
    api<TryOnHistoryRow[]>(`/api/tryon/history?productId=${product.id}`, { auth: true })
      .then((rows) => {
        const done = rows.filter((r) => r.status === 'SUCCESS' && r.resultImageUrl);
        setRuns(done);
        setCurrentId((id) => id ?? done[0]?.id ?? null);
      })
      .catch(() => {});
  }, [product.id]);

  const loadQuota = useCallback(() => {
    api<TryOnQuota>('/api/tryon/quota', { auth: true }).then(setQuota).catch(() => {});
  }, []);

  // Load once the panel is actually opened — a shopper who never tries it on
  // should not pay for these requests.
  useEffect(() => {
    if (!open || !loggedIn) return;
    loadQuota();
    loadRuns();
  }, [open, loggedIn, loadQuota, loadRuns]);

  // Close on Escape, and stop the page behind from scrolling.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  // Local preview for a photo the shopper just picked but has not run yet.
  useEffect(() => {
    if (!pendingPhoto) {
      setPendingPreview('');
      return;
    }
    const url = URL.createObjectURL(pendingPhoto);
    setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingPhoto]);

  function pickPhoto(file: File | undefined) {
    if (!file) return;
    if (file.size > TRYON_PHOTO_MAX_BYTES) {
      setError('That photo is over 5 MB. Please pick a smaller one.');
      return;
    }
    setError('');
    setPendingPhoto(file);
  }

  async function generate() {
    if (generating) return;
    setError('');
    setGenerating(true);
    try {
      let photoUrl = savedPhotoUrl ?? '';
      if (pendingPhoto) {
        [photoUrl] = await uploadImages([pendingPhoto]);
        // Remember it, so the next try-on anywhere on the site is one press.
        await api('/api/tryon/photo', { body: { photoUrl }, auth: true }).catch(() => {});
      }
      if (!photoUrl) {
        setError('Add a photo of yourself to try this on.');
        return;
      }
      const result = await api<TryOnResult>('/api/tryon', {
        body: {
          productId: product.id,
          photoUrl,
          ...(variant ? { variantSize: variant.size, variantColor: variant.color } : {}),
        },
        auth: true,
      });
      if (result.status === 'FAILED') {
        setError(result.errorMessage ?? 'Try-on failed. Please try another photo.');
        return;
      }
      setPendingPhoto(null);
      setCurrentId(result.id);
      loadRuns();
      loadQuota();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the server');
    } finally {
      setGenerating(false);
    }
  }

  async function rate(feedback: TryOnFeedback) {
    if (!current) return;
    const next = current.feedback === feedback ? null : feedback;
    setRuns((prev) => prev.map((r) => (r.id === current.id ? { ...r, feedback: next } : r)));
    await api(`/api/tryon/${current.id}/feedback`, { body: { feedback: next }, auth: true }).catch(
      () => setError('Could not save your rating'),
    );
  }

  async function removeSavedPhoto() {
    await api('/api/tryon/photo', { method: 'DELETE', auth: true }).catch(() => {});
    setPendingPhoto(null);
    loadQuota();
  }

  if (!open) return null;

  const showPhoto = pendingPreview || savedPhotoUrl;
  const outOfRuns = quota != null && quota.usedToday >= quota.dailyLimit;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label="AI Try-On">
      <div className="absolute inset-0 bg-ink-950/40 backdrop-blur-[1px]" onClick={onClose} />

      <aside className="relative flex h-full w-full flex-col bg-white shadow-2xl sm:w-[92%] md:w-[60%] lg:w-[46%] xl:w-[42%]">
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-bold text-ink-900">✨ AI Try-On</p>
            <p className="mt-0.5 truncate text-xs text-gray-500">{product.title}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close try-on"
            className="shrink-0 rounded-full p-1.5 text-2xl leading-none text-gray-400 transition hover:bg-gray-100 hover:text-ink-900"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!loggedIn ? (
            <div className="py-12 text-center">
              <p className="text-sm text-gray-600">Sign in to try this on.</p>
              <Link
                href="/login"
                className="mt-4 inline-block rounded-lg bg-ink-900 px-6 py-2.5 text-sm font-bold text-white hover:bg-ink-800"
              >
                Sign In
              </Link>
            </div>
          ) : (
            <>
              {/* Result, or the photo waiting to be used */}
              <div className="relative overflow-hidden rounded-2xl bg-cream-100">
                {current?.resultImageUrl && !pendingPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={current.resultImageUrl}
                    alt={`${product.title} tried on`}
                    className="max-h-[52vh] w-full object-contain"
                  />
                ) : showPhoto ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={showPhoto}
                    alt="Your photo"
                    className="max-h-[52vh] w-full object-contain opacity-95"
                  />
                ) : (
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex w-full flex-col items-center gap-2 px-6 py-16 text-center"
                  >
                    <span className="text-3xl text-brand-600">⬆</span>
                    <span className="text-sm font-bold text-brand-700">Add your photo</span>
                    <span className="text-xs text-gray-500">JPG, PNG or WEBP, up to 5 MB</span>
                  </button>
                )}

                {generating && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/80">
                    <span className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
                    <p className="text-sm font-semibold text-ink-900">Putting it on you…</p>
                    <p className="text-xs text-gray-500">This usually takes a few seconds</p>
                  </div>
                )}
              </div>

              {/* Past runs for this product */}
              {runs.length > 1 && (
                <div className="scrollbar-none mt-3 flex gap-2 overflow-x-auto">
                  {runs.map((run) => (
                    <button
                      key={run.id}
                      onClick={() => setCurrentId(run.id)}
                      className={`shrink-0 overflow-hidden rounded-lg border-2 transition ${
                        run.id === current?.id ? 'border-brand-600' : 'border-transparent opacity-70'
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={run.resultImageUrl!} alt="" className="h-16 w-12 object-cover" />
                    </button>
                  ))}
                </div>
              )}

              {error && (
                <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
              )}

              {/* Rate the fit */}
              {current && !pendingPreview && (
                <div className="mt-3 flex items-center justify-between rounded-xl border border-gray-100 px-3 py-2">
                  <span className="text-xs font-semibold text-ink-900">Happy with the fit?</span>
                  <div className="flex gap-1.5">
                    {(['UP', 'DOWN'] as const).map((value) => (
                      <button
                        key={value}
                        onClick={() => void rate(value)}
                        aria-label={value === 'UP' ? 'Good fit' : 'Poor fit'}
                        className={`rounded-lg px-2.5 py-1 text-sm transition ${
                          current.feedback === value
                            ? 'bg-brand-100 ring-1 ring-brand-600'
                            : 'hover:bg-gray-100'
                        }`}
                      >
                        {value === 'UP' ? '👍' : '👎'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Photo controls */}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="font-semibold text-brand-600 hover:underline"
                >
                  {showPhoto ? 'Use a different photo' : 'Add your photo'}
                </button>
                {pendingPhoto && (
                  <button
                    onClick={() => setPendingPhoto(null)}
                    className="text-gray-500 hover:underline"
                  >
                    Keep my saved photo
                  </button>
                )}
                {savedPhotoUrl && !pendingPhoto && (
                  <button onClick={() => void removeSavedPhoto()} className="text-gray-400 hover:underline">
                    Delete saved photo
                  </button>
                )}
              </div>

              <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
                Only the garment changes — your pose, face and background stay exactly as they are.
                Your photo is never shown to sellers.
              </p>

              {!showPhoto && (
                <ul className="mt-3 grid grid-cols-2 gap-1.5 text-[11px] text-gray-500">
                  {PHOTO_TIPS.map((tip) => (
                    <li key={tip}>✓ {tip}</li>
                  ))}
                </ul>
              )}

              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => pickPhoto(e.target.files?.[0])}
              />
            </>
          )}
        </div>

        {/* Footer action */}
        {loggedIn && (
          <footer className="shrink-0 border-t border-gray-100 px-5 py-3">
            <button
              onClick={() => void generate()}
              disabled={generating || outOfRuns || (!showPhoto && !pendingPhoto)}
              className="w-full rounded-xl bg-ink-900 py-3 text-sm font-bold uppercase tracking-wide text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generating
                ? 'Generating…'
                : outOfRuns
                  ? "You've used today's try-ons"
                  : runs.length > 0
                    ? '✨ Try again'
                    : '✨ Generate my try-on'}
            </button>
            {quota && !outOfRuns && (
              <p className="mt-1.5 text-center text-[11px] text-gray-500">
                {quota.dailyLimit - quota.usedToday} of {quota.dailyLimit} left today
                {variant?.label ? ` · ${variant.label}` : ''}
              </p>
            )}
          </footer>
        )}
      </aside>
    </div>
  );
}
